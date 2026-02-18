import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SHOW_COST,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ONLY,
  TRIGGER_PATTERN,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { TelegramChannel } from './channels/telegram.js';
import {
  calculateCost,
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { indexAllDocuments, watchUploads } from './document-processor.js';
import { stopEmbeddingService } from './embedding-client.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher, stopIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

// Tool name → friendly progress description for live Telegram updates
const TOOL_PROGRESS: Record<string, string> = {
  search_documents: '\u{1F50D} Searching documents...',
  search_conversations: '\u{1F4AC} Searching conversations...',
  semantic_search: '\u{1F9E0} Semantic search...',
  Read: '\u{1F4D6} Reading files...',
  Write: '\u{270F}\u{FE0F} Writing files...',
  Edit: '\u{270F}\u{FE0F} Editing files...',
  Bash: '\u{2699}\u{FE0F} Running commands...',
  WebSearch: '\u{1F310} Searching the web...',
  WebFetch: '\u{1F310} Fetching web content...',
  Glob: '\u{1F4C2} Scanning files...',
  Grep: '\u{1F50E} Searching code...',
  Task: '\u{1F916} Delegating to sub-agent...',
  mcp__tavily__tavily_search: '\u{1F310} Searching the web...',
  mcp__nanoclaw__send_message: '\u{1F4AC} Sending message...',
};
const DEFAULT_PROGRESS = '\u{23F3} Processing...';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const uploadWatchers: Array<() => void> = [];

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(
      (c) =>
        c.jid !== '__group_sync__' &&
        (c.jid.endsWith('@g.us') || c.jid.startsWith('tg:')),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const allMissedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (allMissedMessages.length === 0) return true;

  // Limit batch size to prevent long-running sessions (max 10 messages per cycle)
  const MAX_BATCH_SIZE = parseInt(process.env.MAX_MESSAGE_BATCH_SIZE || '10', 10);
  const missedMessages = allMissedMessages.slice(0, MAX_BATCH_SIZE);

  if (allMissedMessages.length > MAX_BATCH_SIZE) {
    logger.info(
      {
        group: group.name,
        totalPending: allMissedMessages.length,
        processingNow: missedMessages.length,
        remaining: allMissedMessages.length - MAX_BATCH_SIZE,
      },
      'Large message backlog - processing in batches',
    );
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) {
      // Advance timestamp even without trigger so recovery doesn't keep finding these messages
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      return true;
    }
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Find the channel that owns this JID
  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel found for JID');
    return true;
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let containerDidWork = false;
  // Track the cursor at the time of last successful output so we can roll
  // back follow-up messages that were piped but never got a response.
  let lastConfirmedCursor = lastAgentTimestamp[chatJid] || '';

  // Keep typing indicator alive during processing
  const typingInterval = setInterval(() => {
    channel.setTyping?.(chatJid, true);
  }, 4000); // Refresh every 4 seconds

  // Track whether the agent used tools (for null-result detection)
  let agentUsedTools = false;

  // Progress message state (Telegram only — channels with editMessage support)
  let progressMessageId: string | null = null;
  // Promise that resolves once the initial progress message has been sent.
  // onProgress awaits this to avoid racing with the timer's sendMessage call.
  let progressReady: Promise<void> = Promise.resolve();
  // Serialize editMessage calls so rapid tool invocations don't cause out-of-order updates
  let editChain: Promise<void> = Promise.resolve();

  // Send initial progress message after a short delay (only for channels that support editing)
  const progressTimer = channel.editMessage
    ? setTimeout(() => {
        progressReady = (async () => {
          const id = await channel.sendMessage(chatJid, '\u{23F3} Analyzing your request...');
          if (typeof id === 'string') {
            progressMessageId = id;
          }
        })();
      }, 750)
    : null;

  let output: 'success' | 'error' = 'error';
  try {
  output = await runAgent(group, prompt, chatJid, async (result) => {
    try {
    // Streaming output callback — called for each agent result
    if (result.result) {
      // Cancel progress timer if it hasn't fired yet
      if (progressTimer) clearTimeout(progressTimer);
      // Wait for any in-flight progress message send/edit to settle
      await progressReady;
      await editChain;
      // Delete progress message before sending real output
      if (progressMessageId && channel.deleteMessage) {
        await channel.deleteMessage(chatJid, progressMessageId);
        progressMessageId = null;
      }

      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      containerDidWork = true;
      // Stop typing indicator refresh once we start sending output
      clearInterval(typingInterval);
      const formatted = formatOutbound(channel, raw);
      if (formatted) {
        await channel.sendMessage(chatJid, formatted);
        outputSentToUser = true;
        // Snapshot the cursor at the time output was delivered — any messages
        // piped after this point can be safely rolled back on container error.
        lastConfirmedCursor = lastAgentTimestamp[chatJid] || lastConfirmedCursor;

        // Send per-turn cost footer
        if (SHOW_COST && result.usage) {
          const model = process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
          const cost = calculateCost(result.usage.input_tokens, result.usage.output_tokens, model);
          const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
          const costLine = `_\u{1F4B0} ${fmt(result.usage.input_tokens)} in \u{00B7} ${fmt(result.usage.output_tokens)} out \u{00B7} $${cost.toFixed(4)}_`;
          await channel.sendMessage(chatJid, costLine);
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
      agentUsedTools = false;
    } else if (result.result === null && agentUsedTools) {
      // Agent used tools but returned no text — the user would see silence.
      // Send a fallback so the user knows the turn completed.
      containerDidWork = true;
      logger.warn({ group: group.name }, 'Agent returned null result after using tools — sending fallback');
      if (progressTimer) clearTimeout(progressTimer);
      await progressReady;
      await editChain;
      if (progressMessageId && channel.deleteMessage) {
        await channel.deleteMessage(chatJid, progressMessageId);
        progressMessageId = null;
      }
      await channel.sendMessage(chatJid, '_Task completed (no response from agent)_');
      outputSentToUser = true;
      lastConfirmedCursor = lastAgentTimestamp[chatJid] || lastConfirmedCursor;
      resetIdleTimer();
      // Reset for next piped turn
      agentUsedTools = false;
    }

    if (result.status === 'error') {
      hadError = true;
    }
    } catch (err) {
      logger.error({ group: group.name, err: String(err) }, 'Error in output callback');
      hadError = true;
    }
  }, (tool: string) => {
    // Progress update — edit the progress message with current tool description.
    // Serialized through editChain to guarantee ordering and awaits progressReady
    // to handle the race between the timer's sendMessage and early tool calls.
    agentUsedTools = true;
    if (!channel.editMessage) return;
    const description = TOOL_PROGRESS[tool] || DEFAULT_PROGRESS;
    logger.debug({ group: group.name, tool, hasProgressMsg: !!progressMessageId }, 'onProgress fired');
    editChain = editChain
      .then(() => progressReady)
      .then(async () => {
        if (!progressMessageId) {
          // No active progress message (first tool call, or previous turn's
          // message was deleted). Create a new one for this turn.
          logger.info({ group: group.name, description }, 'Creating new progress message');
          const id = await channel.sendMessage(chatJid, description);
          if (typeof id === 'string') {
            progressMessageId = id;
            logger.info({ group: group.name, progressMessageId: id }, 'Progress message created');
          }
          return;
        }
        logger.debug({ group: group.name, progressMessageId, description }, 'Editing progress message');
        return channel.editMessage!(chatJid, progressMessageId, description);
      })
      .catch((err) => {
        logger.warn({ group: group.name, err }, 'Progress update failed');
      });
  });
  } finally {
    // Clean up typing indicator and timers
    clearInterval(typingInterval);
    if (progressTimer) clearTimeout(progressTimer);
    if (idleTimer) clearTimeout(idleTimer);
    const withTimeout = (p: Promise<unknown>, ms: number) =>
      Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
    try { await withTimeout(progressReady, 5000); } catch {}
    try { await withTimeout(editChain, 5000); } catch {}
    if (progressMessageId && channel.deleteMessage) {
      channel.deleteMessage(chatJid, progressMessageId).catch(() => {});
    }
    await channel.setTyping?.(chatJid, false);
  }

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      // Output was sent, but follow-up messages may have been piped after
      // the last response.  Roll back to lastConfirmedCursor so those
      // unprocessed messages get re-queued on the next loop iteration.
      if (lastAgentTimestamp[chatJid] !== lastConfirmedCursor) {
        lastAgentTimestamp[chatJid] = lastConfirmedCursor;
        saveState();
        logger.warn(
          { group: group.name, rolledBackTo: lastConfirmedCursor },
          'Agent error after output — rolled back cursor to recover piped messages',
        );
      } else {
        logger.warn({ group: group.name }, 'Agent error after output was sent, no piped messages to recover');
      }
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  // Container exited cleanly but produced no output — roll back cursor
  // so messages will be re-queued on next loop iteration.
  if (!containerDidWork && !hadError) {
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Container exited without output, rolled back cursor');
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onProgress?: (tool: string) => void,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      onProgress,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Typing indicator already managed by active container
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  let runtime: 'docker' | 'container' | null = null;

  // Try Docker first
  try {
    execSync('docker info', { stdio: 'pipe' });
    logger.debug('Docker is running');
    runtime = 'docker';
  } catch {
    // Docker not available, try Apple Container
    try {
      execSync('container system status', { stdio: 'pipe' });
      logger.debug('Apple Container system already running');
      runtime = 'container';
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        execSync('container system start', { stdio: 'pipe', timeout: 30000 });
        logger.info('Apple Container system started');
        runtime = 'container';
      } catch (err) {
        logger.error({ err }, 'Failed to start container runtime');
        console.error(
          '\n╔════════════════════════════════════════════════════════════════╗',
        );
        console.error(
          '║  FATAL: No container runtime available                         ║',
        );
        console.error(
          '║                                                                ║',
        );
        console.error(
          '║  NanoClaw requires Docker or Apple Container to run agents.   ║',
        );
        console.error(
          '║                                                                ║',
        );
        console.error(
          '║  Option 1 - Docker (Recommended):                             ║',
        );
        console.error(
          '║    • Install from: https://www.docker.com/get-started          ║',
        );
        console.error(
          '║    • Start Docker Desktop and wait for it to be ready          ║',
        );
        console.error(
          '║    • Restart NanoClaw                                          ║',
        );
        console.error(
          '║                                                                ║',
        );
        console.error(
          '║  Option 2 - Apple Container (macOS only):                     ║',
        );
        console.error(
          '║    • Install from: https://github.com/apple/container/releases ║',
        );
        console.error(
          '║    • Run: container system start                               ║',
        );
        console.error(
          '║    • Restart NanoClaw                                          ║',
        );
        console.error(
          '╚════════════════════════════════════════════════════════════════╝\n',
        );
        throw new Error('Container runtime is required but none is available');
      }
    }
  }

  if (!runtime) {
    throw new Error('Failed to detect container runtime');
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    let orphans: string[] = [];

    if (runtime === 'docker') {
      // Docker: list ALL containers with nanoclaw- prefix (name-based, not image-based,
      // because ancestor filter breaks after image rebuilds change the image hash)
      const output = execSync(
        'docker ps -a --filter "name=nanoclaw-" --format "{{.Names}}"',
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        },
      );
      orphans = output
        .trim()
        .split('\n')
        .filter((name) => name && name.length > 0);
    } else {
      // Apple Container: use ls --format json
      const output = execSync('container ls --format json', {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(output || '[]');
      orphans = containers
        .filter(
          (c) =>
            c.status === 'running' &&
            c.configuration.id.startsWith('nanoclaw-'),
        )
        .map((c) => c.configuration.id);
    }

    for (const name of orphans) {
      try {
        execSync(`${runtime} stop ${name}`, { stdio: 'pipe' });
        if (runtime === 'docker') {
          execSync(`${runtime} rm ${name}`, { stdio: 'pipe' });
        }
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Health check interval reference (set later, cleaned up on shutdown)
  let healthInterval: ReturnType<typeof setInterval> | null = null;

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (healthInterval) clearInterval(healthInterval);
    stopIpcWatcher();
    for (const cleanup of uploadWatchers) cleanup();
    stopEmbeddingService();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string) =>
      storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  if (!TELEGRAM_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
    channels.push(telegram);
    await telegram.connect();
  }

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      const text = formatOutbound(channel, rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await channel.sendMessage(jid, text);
    },
    sendFile: async (jid, filePath, groupFolder, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile) throw new Error(`Channel ${channel.name} does not support file sending`);
      // Resolve group-relative path to absolute path with traversal protection
      const absolutePath = path.resolve(path.join(GROUPS_DIR, groupFolder, filePath));
      const groupDir = path.resolve(path.join(GROUPS_DIR, groupFolder));
      if (!absolutePath.startsWith(groupDir + path.sep) && absolutePath !== groupDir) {
        logger.warn({ groupFolder, filePath }, 'Path traversal blocked in send_file');
        throw new Error('File path outside group directory');
      }
      return channel.sendFile(jid, absolutePath, caption);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) =>
      whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Index documents in background (non-blocking)
  for (const [, group] of Object.entries(registeredGroups)) {
    indexAllDocuments(group.folder).catch((err) => {
      logger.warn({ err, group: group.folder }, 'Background document indexing failed');
    });
    const cleanup = watchUploads(group.folder, (filePath) => {
      logger.info({ filePath, group: group.folder }, 'New upload indexed');
    });
    uploadWatchers.push(cleanup);
  }

  // Lightweight health check — runs in the host process (not a container)
  // every 5 minutes. Verifies channels, DB, and container health. Alerts
  // the main group via the first connected channel if something is wrong.
  const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  let lastHealthAlert = 0;
  const HEALTH_ALERT_COOLDOWN = 30 * 60 * 1000; // Don't spam: max 1 alert per 30 min

  const healthCheck = () => {
    const issues: string[] = [];

    // 1. Check channel connectivity
    for (const ch of channels) {
      if (!ch.isConnected()) {
        issues.push(`${ch.name} disconnected`);
      }
    }

    // 2. Check SQLite is responsive
    try {
      getRouterState('last_timestamp');
    } catch (err) {
      issues.push(`SQLite error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Check for stuck containers (running > max runtime * 1.5)
    // Uses execSync from the top-level import — no dynamic require needed.
    const maxRuntime = parseInt(process.env.CONTAINER_MAX_RUNTIME || '7200000', 10);
    const stuckThresholdHours = (maxRuntime * 1.5) / (3600 * 1000); // e.g. 3h for 2h default
    try {
      let running: string[] = [];
      try {
        const output = execSync(
          'docker ps --filter "name=nanoclaw-" --format "{{.Names}} {{.RunningFor}}"',
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
        );
        running = output.trim().split('\n').filter(Boolean);
      } catch {
        // Docker not available or not running — skip stuck container check
      }
      for (const line of running) {
        if (line.includes('hours') || line.includes('hour')) {
          const hours = parseInt(line.match(/(\d+)\s*hour/)?.[1] || '0', 10);
          if (hours >= stuckThresholdHours) {
            issues.push(`Container may be stuck: ${line.split(' ')[0]} (${hours}h)`);
          }
        }
      }
    } catch {
      // Container check failed — non-fatal, skip
    }

    if (issues.length > 0 && Date.now() - lastHealthAlert > HEALTH_ALERT_COOLDOWN) {
      lastHealthAlert = Date.now();
      const alertText = `⚠️ *Health Check Alert*\n\n${issues.map(i => `• ${i}`).join('\n')}`;
      logger.warn({ issues }, 'Health check found issues');

      // Find main group JID and send alert
      const mainEntry = Object.entries(registeredGroups).find(
        ([_, g]) => g.folder === MAIN_GROUP_FOLDER,
      );
      if (mainEntry) {
        const [mainJid] = mainEntry;
        const ch = findChannel(channels, mainJid);
        if (ch) {
          ch.sendMessage(mainJid, alertText).catch((err) => {
            logger.error({ err }, 'Failed to send health alert');
          });
        }
      }
    } else if (issues.length > 0) {
      logger.debug({ issues }, 'Health check issues (alert on cooldown)');
    }
  };

  healthInterval = setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
  // Run first check after 60s (let channels stabilize)
  setTimeout(healthCheck, 60000);

  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
