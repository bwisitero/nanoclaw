import { Bot, InputFile } from 'grammy';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import https from 'https';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false; // Telegram bots already display their name

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private connected = false; // Tracks actual polling state, not just bot object existence
  private reconnecting = false;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a file from Telegram and save it to the group's uploads directory
   */
  private async downloadFile(
    fileId: string,
    fileName: string,
    groupFolder: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      // Get file path from Telegram
      const file = await this.bot.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

      // Create uploads directory for this group
      const uploadsDir = path.join(GROUPS_DIR, groupFolder, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      // Generate unique filename with timestamp
      const timestamp = Date.now();
      const ext = path.extname(fileName) || '';
      const baseName = path.basename(fileName, ext);
      const uniqueFileName = `${timestamp}-${baseName}${ext}`;
      const filePath = path.join(uploadsDir, uniqueFileName);

      // Download file
      return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(filePath);
        https
          .get(fileUrl, (response) => {
            response.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              logger.info(
                { fileName: uniqueFileName, size: file.file_size },
                'File downloaded from Telegram',
              );
              resolve(filePath);
            });
          })
          .on('error', (err) => {
            fs.unlinkSync(filePath);
            logger.error({ err, fileName }, 'Failed to download file');
            reject(err);
          });
      });
    } catch (err) {
      logger.error({ err, fileId }, 'Failed to get file from Telegram');
      return null;
    }
  }

  /**
   * Transcribe voice note using OpenAI Whisper API
   */
  private async transcribeVoice(audioPath: string): Promise<string | null> {
    try {
      // Check if transcription config exists
      const configPath = path.join(process.cwd(), '.transcription.config.json');
      if (!fs.existsSync(configPath)) {
        logger.debug('Transcription config not found');
        return null;
      }

      const configData = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configData);

      if (!config.enabled || !config.openai?.apiKey) {
        logger.debug('Transcription not configured or disabled');
        return null;
      }

      // Dynamic import of openai
      const openaiModule = await import('openai');
      const OpenAI = openaiModule.default;

      const openai = new OpenAI({ apiKey: config.openai.apiKey });

      // Transcribe using Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: config.openai.model || 'whisper-1',
        response_format: 'text',
      });

      return (transcription as unknown as string).trim();
    } catch (err) {
      logger.error({ err, audioPath }, 'Voice transcription failed');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @team_a3_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Frankie\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          logger.debug(
            { chatJid, botUsername, originalContent: content },
            'Translating bot mention to trigger pattern',
          );
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Check if this message will trigger a response before sending typing indicator
      // Only send typing if: (1) group doesn't require trigger, OR (2) message has trigger
      const willRespond = group.requiresTrigger === false || TRIGGER_PATTERN.test(content.trim());
      if (willRespond) {
        // Send typing indicator immediately so user knows message was received
        await this.setTyping(chatJid, true);
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle photo messages
    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      let caption = ctx.message.caption || '';

      // Translate bot @mentions in caption to TRIGGER_PATTERN format
      if (caption) {
        const botUsername = ctx.me?.username?.toLowerCase();
        if (botUsername) {
          const entities = ctx.message.caption_entities || [];
          const isBotMentioned = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = caption
                .substring(entity.offset, entity.offset + entity.length)
                .toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (isBotMentioned && !TRIGGER_PATTERN.test(caption)) {
            caption = `@${ASSISTANT_NAME} ${caption}`;
          }
        }
      }

      // Download the largest photo size
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const filePath = await this.downloadFile(
        photo.file_id,
        `photo-${timestamp}.jpg`,
        group.folder,
      );

      const fileRef = filePath
        ? `[Photo uploaded: ${path.relative(GROUPS_DIR, filePath)}]`
        : '[Photo]';

      // Put caption FIRST so trigger pattern can match at start of string
      const content = caption
        ? `${caption}\n\n${fileRef}`
        : fileRef;

      // Check if this message will trigger a response before sending typing indicator
      const willRespond = group.requiresTrigger === false || TRIGGER_PATTERN.test(content.trim());
      if (willRespond) {
        await this.setTyping(chatJid, true);
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    // Handle video messages
    this.bot.on('message:video', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      let caption = ctx.message.caption || '';

      // Translate bot @mentions in caption to TRIGGER_PATTERN format
      if (caption) {
        const botUsername = ctx.me?.username?.toLowerCase();
        if (botUsername) {
          const entities = ctx.message.caption_entities || [];
          const isBotMentioned = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = caption
                .substring(entity.offset, entity.offset + entity.length)
                .toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (isBotMentioned && !TRIGGER_PATTERN.test(caption)) {
            caption = `@${ASSISTANT_NAME} ${caption}`;
          }
        }
      }

      const fileName = ctx.message.video.file_name || `video-${timestamp}.mp4`;
      const filePath = await this.downloadFile(ctx.message.video.file_id, fileName, group.folder);

      const fileRef = filePath
        ? `[Video uploaded: ${path.relative(GROUPS_DIR, filePath)}]`
        : '[Video]';

      // Put caption FIRST so trigger pattern can match at start of string
      const content = caption
        ? `${caption}\n\n${fileRef}`
        : fileRef;

      // Check if this message will trigger a response before sending typing indicator
      const willRespond = group.requiresTrigger === false || TRIGGER_PATTERN.test(content.trim());
      if (willRespond) {
        await this.setTyping(chatJid, true);
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    // Handle voice messages (with transcription)
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      const filePath = await this.downloadFile(
        ctx.message.voice.file_id,
        `voice-${timestamp}.ogg`,
        group.folder,
      );

      let content = '[Voice message]';
      if (filePath) {
        // Attempt transcription
        const transcript = await this.transcribeVoice(filePath);
        if (transcript) {
          content = `[Voice: ${transcript}]\n\nAudio file: ${path.relative(GROUPS_DIR, filePath)}`;
          logger.info(
            { chatJid, length: transcript.length },
            'Transcribed voice message',
          );
        } else {
          content = `[Voice message - transcription unavailable]\n\nAudio file: ${path.relative(GROUPS_DIR, filePath)}`;
        }
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    // Handle audio messages
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      const fileName = ctx.message.audio.file_name || `audio-${timestamp}.mp3`;
      const filePath = await this.downloadFile(ctx.message.audio.file_id, fileName, group.folder);

      const content = filePath
        ? `[Audio file uploaded: ${path.relative(GROUPS_DIR, filePath)}]`
        : '[Audio file]';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    // Handle document messages
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      let caption = ctx.message.caption || '';

      // Translate bot @mentions in caption to TRIGGER_PATTERN format
      if (caption) {
        const botUsername = ctx.me?.username?.toLowerCase();
        if (botUsername) {
          const entities = ctx.message.caption_entities || [];
          const isBotMentioned = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = caption
                .substring(entity.offset, entity.offset + entity.length)
                .toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (isBotMentioned && !TRIGGER_PATTERN.test(caption)) {
            caption = `@${ASSISTANT_NAME} ${caption}`;
          }
        }
      }

      const fileName = ctx.message.document.file_name || `document-${timestamp}`;
      const filePath = await this.downloadFile(
        ctx.message.document.file_id,
        fileName,
        group.folder,
      );

      const fileRef = filePath
        ? `[Document uploaded: ${path.relative(GROUPS_DIR, filePath)}]`
        : `[Document: ${fileName}]`;

      // Put caption FIRST so trigger pattern can match at start of string
      const content = caption
        ? `${caption}\n\n${fileRef}`
        : fileRef;

      // Check if this message will trigger a response before sending typing indicator
      const willRespond = group.requiresTrigger === false || TRIGGER_PATTERN.test(content.trim());
      if (willRespond) {
        await this.setTyping(chatJid, true);
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    // Stickers, location, contact remain as placeholders (no file storage needed)
    this.bot.on('message:sticker', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const emoji = ctx.message.sticker?.emoji || '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `[Sticker ${emoji}]`,
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:location', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: '[Location]',
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:contact', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: '[Contact]',
        timestamp,
        is_from_me: false,
      });
    });

    // Handle errors gracefully — log and attempt reconnect if polling dies
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started.
    // grammy's bot.start() returns a promise that resolves when polling
    // begins, but the polling itself runs in the background. If it dies
    // (network outage, API error), we detect it and reconnect.
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          this.connected = true;
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      }).then(() => {
        // bot.start() promise resolves when polling STOPS (normally via bot.stop())
        // If we didn't disconnect intentionally, this means polling died — reconnect.
        if (this.connected && !this.reconnecting) {
          logger.warn('Telegram polling stopped unexpectedly, reconnecting...');
          this.connected = false;
          this.scheduleReconnect();
        }
      }).catch((err) => {
        logger.error({ err }, 'Telegram polling crashed');
        this.connected = false;
        this.scheduleReconnect();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<string | void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      let lastMessageId: string | undefined;

      // Helper: send a single chunk with Markdown, falling back to plain text
      const sendChunk = async (chunk: string): Promise<string> => {
        try {
          const sent = await this.bot!.api.sendMessage(numericId, chunk, {
            parse_mode: 'Markdown',
          });
          return sent.message_id.toString();
        } catch {
          // Markdown parse failed (unmatched delimiters, etc.) — send as plain text
          const sent = await this.bot!.api.sendMessage(numericId, chunk);
          return sent.message_id.toString();
        }
      };

      if (text.length <= MAX_LENGTH) {
        lastMessageId = await sendChunk(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          lastMessageId = await sendChunk(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
      return lastMessageId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  /**
   * Send a file attachment to a Telegram chat
   * @param jid Chat JID (e.g., tg:123456789)
   * @param filePath Absolute path to file on host (will be resolved relative to GROUPS_DIR if needed)
   * @param caption Optional caption for the file
   */
  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Resolve file path if it's relative to groups directory
      let absolutePath = filePath;
      if (!path.isAbsolute(filePath)) {
        absolutePath = path.join(GROUPS_DIR, filePath);
      }

      // Check if file exists
      if (!fs.existsSync(absolutePath)) {
        logger.error({ filePath: absolutePath }, 'File not found for sending');
        throw new Error(`File not found: ${absolutePath}`);
      }

      // Determine file type by extension
      const ext = path.extname(absolutePath).toLowerCase();
      const fileName = path.basename(absolutePath);

      // Send based on file type
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        // Send as photo
        await this.bot.api.sendPhoto(numericId, new InputFile(absolutePath), {
          caption: caption || undefined,
        });
        logger.info({ jid, fileName, type: 'photo' }, 'Telegram photo sent');
      } else if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) {
        // Send as video
        await this.bot.api.sendVideo(numericId, new InputFile(absolutePath), {
          caption: caption || undefined,
        });
        logger.info({ jid, fileName, type: 'video' }, 'Telegram video sent');
      } else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) {
        // Send as audio
        await this.bot.api.sendAudio(numericId, new InputFile(absolutePath), {
          caption: caption || undefined,
        });
        logger.info({ jid, fileName, type: 'audio' }, 'Telegram audio sent');
      } else {
        // Send as document (generic file)
        await this.bot.api.sendDocument(numericId, new InputFile(absolutePath), {
          caption: caption || undefined,
        });
        logger.info({ jid, fileName, type: 'document' }, 'Telegram document sent');
      }
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram file');
      throw err;
    }
  }

  async editMessage(jid: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) return;
    try {
      const chatId = jid.replace(/^tg:/, '');
      try {
        await this.bot.api.editMessageText(chatId, Number(messageId), text, {
          parse_mode: 'Markdown',
        });
      } catch {
        await this.bot.api.editMessageText(chatId, Number(messageId), text);
      }
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to edit Telegram message');
    }
  }

  async deleteMessage(jid: string, messageId: string): Promise<void> {
    if (!this.bot) return;
    try {
      const chatId = jid.replace(/^tg:/, '');
      await this.bot.api.deleteMessage(chatId, Number(messageId));
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to delete Telegram message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false; // Set before stop so the polling-end handler doesn't trigger reconnect
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  /**
   * Reconnect after polling dies. Exponential backoff: 5s, 10s, 20s, 40s, max 60s.
   * Recreates the bot instance and re-registers all handlers via connect().
   */
  private reconnectAttempts = 0;
  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
    logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Scheduling Telegram reconnect');

    setTimeout(async () => {
      try {
        // Clean up old bot instance
        if (this.bot) {
          try { this.bot.stop(); } catch { /* ignore */ }
          this.bot = null;
        }
        this.reconnecting = false;
        await this.connect();
        this.reconnectAttempts = 0; // Reset on success
        logger.info('Telegram reconnected successfully');
      } catch (err) {
        logger.error({ err, attempt: this.reconnectAttempts }, 'Telegram reconnect failed');
        this.reconnecting = false;
        // Try again
        this.scheduleReconnect();
      }
    }, delay);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
