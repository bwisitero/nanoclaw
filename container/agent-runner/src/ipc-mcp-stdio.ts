/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import Database from 'better-sqlite3';
import { loadMemoryConfig, DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './memory-config.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_file',
  'Send a file attachment (photo, video, document, audio) to the user or group. Files in /workspace/group/uploads/ are automatically accessible.',
  {
    file_path: z.string().describe('Path to file relative to /workspace/group/ (e.g., "uploads/edited_image.jpg") or absolute path'),
    caption: z.string().optional().describe('Optional caption/message to include with the file'),
  },
  async (args) => {
    // Validate file exists
    const absolutePath = args.file_path.startsWith('/')
      ? args.file_path
      : path.join('/workspace/group', args.file_path);

    if (!fs.existsSync(absolutePath)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    // Convert absolute path back to group-relative path for host
    const groupRelativePath = absolutePath.replace('/workspace/group/', '');

    const data = {
      type: 'send_file',
      chatJid,
      filePath: groupRelativePath,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `File sent: ${path.basename(args.file_path)}` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'search_memory',
  'Search past conversation summaries and memory files for relevant information. Useful for recalling past discussions, decisions, or facts.',
  {
    query: z.string().describe('Search query or keywords to find in past conversations'),
    limit: z.number().default(10).describe('Maximum number of results to return'),
  },
  async (args) => {
    const conversationsDir = path.join('/workspace/group', 'conversations');
    const memoryDir = path.join('/workspace/group', 'memory');

    const results: string[] = [];

    // Search conversations/*.md files
    if (fs.existsSync(conversationsDir)) {
      const files = fs.readdirSync(conversationsDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse(); // Most recent first

      for (const file of files) {
        if (results.length >= args.limit) break;

        const filePath = path.join(conversationsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Simple grep for query
        const lines = content.split('\n');
        const matches = lines.filter(line =>
          line.toLowerCase().includes(args.query.toLowerCase())
        );

        if (matches.length > 0) {
          results.push(`**${file}**:\n${matches.slice(0, 3).join('\n')}\n`);
        }
      }
    }

    // Search memory/facts.md
    const factsFile = path.join(memoryDir, 'facts.md');
    if (fs.existsSync(factsFile) && results.length < args.limit) {
      const content = fs.readFileSync(factsFile, 'utf-8');
      const lines = content.split('\n');
      const matches = lines.filter(line =>
        line.toLowerCase().includes(args.query.toLowerCase())
      );

      if (matches.length > 0) {
        results.push(`**memory/facts.md**:\n${matches.join('\n')}\n`);
      }
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No results found for "${args.query}". Try broader search terms or check if conversations have been summarized with /compact.`
        }]
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Found ${results.length} result(s):\n\n${results.join('\n---\n\n')}`
      }]
    };
  },
);

server.tool(
  'remember',
  'Save an important fact or piece of information to persistent memory. Use this when the user asks you to remember something, or when you learn something important that should be recalled in future conversations.',
  {
    fact: z.string().describe('The fact or information to remember'),
    category: z.string().optional().describe('Optional category (e.g., "preferences", "work", "family")'),
  },
  async (args) => {
    const memoryDir = path.join('/workspace/group', 'memory');
    const factsFile = path.join(memoryDir, 'facts.md');

    // Create memory directory if it doesn't exist
    fs.mkdirSync(memoryDir, { recursive: true });

    // Create facts file if it doesn't exist
    if (!fs.existsSync(factsFile)) {
      fs.writeFileSync(factsFile, '# Memory\n\nImportant facts and information:\n\n');
    }

    // Append fact with timestamp
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const category = args.category ? ` [${args.category}]` : '';
    const entry = `- **[${timestamp}]**${category} ${args.fact}\n`;

    fs.appendFileSync(factsFile, entry);

    return {
      content: [{
        type: 'text' as const,
        text: `Remembered: ${args.fact}`
      }]
    };
  },
);

server.tool(
  'create_skill',
  'Create a new Claude Code skill that can be invoked with /skill-name. Skills are reusable commands that extend NanoClaw functionality. Main group only.',
  {
    name: z.string().describe('Skill name (lowercase, hyphens, e.g., "backup-to-dropbox")'),
    description: z.string().describe('Brief description of what the skill does (1-2 sentences)'),
    instructions: z.string().describe('Detailed instructions for Claude Code on how to execute this skill'),
    triggers: z.string().optional().describe('Optional: When to automatically invoke this skill (e.g., "user says backup", "user mentions Dropbox")'),
  },
  async (args) => {
    // Only main group can create skills
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can create skills.' }],
        isError: true,
      };
    }

    // Validate skill name format
    const skillName = args.name.toLowerCase().trim();
    if (!/^[a-z0-9-]+$/.test(skillName)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Invalid skill name "${args.name}". Use lowercase letters, numbers, and hyphens only (e.g., "backup-to-dropbox").`
        }],
        isError: true,
      };
    }

    // Check if skill already exists
    const skillsDir = '/workspace/project/.claude/skills';
    const skillDir = path.join(skillsDir, skillName);

    if (fs.existsSync(skillDir)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Skill "/${skillName}" already exists. To modify it, edit .claude/skills/${skillName}/SKILL.md directly.`
        }],
        isError: true,
      };
    }

    // Create skill directory
    fs.mkdirSync(skillDir, { recursive: true });

    // Generate SKILL.md content
    const skillContent = `# ${skillName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}

${args.description}

${args.triggers ? `## When to Use\n\nThis skill should be invoked when:\n${args.triggers}\n\n` : ''}## Instructions

${args.instructions}

## Notes

- This skill was created via the \`create_skill\` tool
- Edit this file directly to modify the skill behavior
- Skills are available immediately after creation

## Usage

\`\`\`
/${skillName}
\`\`\`
`;

    // Write SKILL.md
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, skillContent);

    return {
      content: [{
        type: 'text' as const,
        text: `✅ Skill created: **/${skillName}**\n\nLocation: \`.claude/skills/${skillName}/SKILL.md\`\n\nYou can now use this skill by typing \`/${skillName}\` in Claude Code.`
      }]
    };
  },
);

server.tool(
  'get_costs',
  'Get cost tracking information for this group. Shows recent interactions, total cost for this group, and system-wide total cost. Costs are tracked per API call with input/output token counts.',
  {},
  async () => {
    const costsFile = '/workspace/group/costs.json';

    if (!fs.existsSync(costsFile)) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No cost data available yet. Cost tracking begins after the first interaction following this feature being enabled.'
        }]
      };
    }

    try {
      const costsData = JSON.parse(fs.readFileSync(costsFile, 'utf-8'));
      const formatted = [
        `*Cost Summary for ${groupFolder}*`,
        ``,
        `Group Total: $${costsData.group_total_usd}`,
        `System Total (all groups): $${costsData.system_total_usd}`,
        `Last Updated: ${new Date(costsData.last_updated).toLocaleString()}`,
        ``,
        `*Recent Interactions:*`,
        ...costsData.recent_interactions.slice(0, 10).map((int: any, idx: number) => {
          const time = new Date(int.timestamp).toLocaleString();
          const modelShort = int.model.split('-').slice(-2).join('-'); // e.g., "sonnet-4-5"
          return `${idx + 1}. ${time} | $${int.cost_usd} | ${int.input_tokens}in/${int.output_tokens}out | ${modelShort}`;
        }),
      ];

      return {
        content: [{
          type: 'text' as const,
          text: formatted.join('\n')
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading cost data: ${err}`
        }],
        isError: true,
      };
    }
  },
);

server.tool(
  'configure_memory',
  'View or update memory system configuration for this group. Use this when user requests memory behavior changes or you need to check current settings. Configuration affects: injection mode (automatic/smart/manual), search weights, temporal decay, and diversity filtering.',
  {
    action: z.enum(['get', 'set']).describe('Action to perform: "get" to view current config, "set" to update config'),
    config: z.object({
      injection: z.object({
        mode: z.enum(['automatic', 'smart', 'manual']).optional().describe('Memory injection mode: automatic (always inject), smart (classify queries first), manual (tools only)'),
        maxTokens: z.number().optional().describe('Maximum tokens for injected memory context (default: 500)'),
        maxResults: z.number().optional().describe('Maximum number of search results to inject (default: 10)'),
        relevanceThreshold: z.number().optional().describe('Minimum relevance score (0-1) for including results (default: 0.3)'),
      }).optional(),
      hybridSearch: z.object({
        vectorWeight: z.number().optional().describe('Weight for semantic similarity (0-1, default: 0.6)'),
        keywordWeight: z.number().optional().describe('Weight for keyword matching (0-1, default: 0.4)'),
        temporalDecay: z.boolean().optional().describe('Apply time-based decay to older memories (default: true)'),
        halfLifeDays: z.number().optional().describe('Days for memory relevance to decay by 50% (default: 30)'),
        mmrReranking: z.boolean().optional().describe('Apply MMR diversity filtering (default: true)'),
        mmrLambda: z.number().optional().describe('MMR balance between relevance and diversity (0-1, default: 0.7)'),
      }).optional(),
      evergreen: z.array(z.string()).optional().describe('Files exempt from temporal decay (default: ["CLAUDE.md", "memory/facts.md"])'),
    }).optional().describe('Configuration object (required for "set" action)'),
  },
  async (args) => {
    const groupPath = '/workspace/group';
    const configPath = path.join(groupPath, 'memory-config.json');

    if (args.action === 'get') {
      // Load current config (merges with defaults)
      const currentConfig = loadMemoryConfig(groupPath);

      return {
        content: [{
          type: 'text' as const,
          text: `**Current Memory Configuration:**\n\n\`\`\`json\n${JSON.stringify(currentConfig, null, 2)}\n\`\`\`\n\n**Location:** \`${configPath}\`\n\n${fs.existsSync(configPath) ? '(Using custom config)' : '(Using defaults - no custom config file exists)'}`
        }]
      };
    } else {
      // Set action - validate and write config
      if (!args.config) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: config parameter is required for "set" action'
          }],
          isError: true,
        };
      }

      // Load current config and merge with new values
      const currentConfig = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
        : {};

      const updatedConfig = {
        injection: { ...currentConfig.injection, ...args.config.injection },
        hybridSearch: { ...currentConfig.hybridSearch, ...args.config.hybridSearch },
        evergreen: args.config.evergreen ?? currentConfig.evergreen,
      };

      // Write updated config
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));

      return {
        content: [{
          type: 'text' as const,
          text: `✅ Memory configuration updated successfully.\n\n**New configuration:**\n\`\`\`json\n${JSON.stringify(updatedConfig, null, 2)}\n\`\`\`\n\nChanges will take effect on the next query.`
        }]
      };
    }
  },
);

server.tool(
  'request_skill_from_admin',
  'Request admin approval to create a new skill or MCP server. **IMPORTANT:** Before requesting, ALWAYS research existing solutions first using web search or agent-browser. Look for: (1) Official MCPs from the service provider, (2) Community MCPs on GitHub/npm, (3) Similar skills in .claude/skills/. Only request if no safe, feature-rich solution exists. The admin will review and can approve or decline.',
  {
    name: z.string().describe('Proposed skill name (lowercase-with-hyphens, e.g., "weather-checker") or MCP server name'),
    description: z.string().describe('Brief description of what the skill/MCP should do (1-2 sentences)'),
    reason: z.string().describe('Why you need this capability and what you researched (include: search terms used, MCPs/skills found, why they were unsuitable)'),
    instructions: z.string().optional().describe('Optional: Suggested implementation steps or approach. For MCPs, include the GitHub repo URL and installation command.'),
  },
  async (args) => {
    // Non-main groups use this to request skills from admin
    if (isMain) {
      return {
        content: [{
          type: 'text' as const,
          text: 'You are the admin - use create_skill directly to create skills.'
        }],
        isError: true,
      };
    }

    // Write skill request IPC message
    const data = {
      type: 'skill_request',
      requestingGroup: groupFolder,
      requestingChatJid: chatJid,
      skillName: args.name,
      skillDescription: args.description,
      reason: args.reason,
      instructions: args.instructions || '',
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `✅ Skill request sent to admin\n\n*Requested:* ${args.name}\n\nThe admin will review your request and create the skill if approved.`
      }]
    };
  },
);

// --- Document & Conversation Search Tools ---

const DB_PATH = '/workspace/project/store/messages.db';

/** Escape user input for FTS5 MATCH queries (wraps each token in double-quotes). */
function fts5Escape(query: string): string {
  return query
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter((w: string) => w.length > 0)
    .map((w: string) => `"${w}"`)
    .join(' ');
}

function openSearchDb(): Database.Database | null {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    return new Database(DB_PATH, { readonly: true });
  } catch {
    return null;
  }
}

server.tool(
  'search_documents',
  `Search uploaded documents (PDFs, CSVs, images) for specific information using keyword matching.
Use this to find specific facts, numbers, or terms in tax returns, bank statements, W2s, invoices, etc.
Results include file name, page number, and a text snippet with matches highlighted between >>> and <<<.
For conceptual/meaning-based search, use semantic_search instead.`,
  {
    query: z.string().describe('Search keywords (e.g., "W2 wages 2023", "total tax", "refund amount")'),
    limit: z.number().default(10).describe('Maximum results to return'),
  },
  async (args) => {
    const db = openSearchDb();
    if (!db) {
      return {
        content: [{ type: 'text' as const, text: 'Document search is not available (database not found).' }],
        isError: true,
      };
    }

    try {
      const escaped = fts5Escape(args.query);
      if (!escaped) {
        return { content: [{ type: 'text' as const, text: 'Please provide search keywords.' }] };
      }

      const results = db.prepare(`
        SELECT
          dc.file_name,
          dc.page_number,
          dc.total_pages,
          snippet(document_chunks_fts, 0, '>>>', '<<<', '...', 50) as snippet,
          rank
        FROM document_chunks_fts
        JOIN document_chunks dc ON dc.id = document_chunks_fts.rowid
        WHERE document_chunks_fts MATCH ?
          AND dc.group_folder = ?
        ORDER BY rank
        LIMIT ?
      `).all(escaped, groupFolder, args.limit) as Array<{
        file_name: string;
        page_number: number | null;
        total_pages: number | null;
        snippet: string;
        rank: number;
      }>;

      if (results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No documents found matching "${args.query}". Try different keywords or use semantic_search for meaning-based search.`
          }],
        };
      }

      const formatted = results.map((r, i) => {
        const page = r.page_number ? ` (page ${r.page_number}${r.total_pages ? `/${r.total_pages}` : ''})` : '';
        return `**${i + 1}. ${r.file_name}**${page}\n${r.snippet}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Found ${results.length} result(s) for "${args.query}":\n\n${formatted}`
        }],
      };
    } finally {
      db.close();
    }
  },
);

server.tool(
  'search_conversations',
  `Search past conversation messages for specific information using keyword matching.
Use this to find what was discussed about a topic, decisions made, or information shared in chat.
Results include sender name and a text snippet with matches highlighted between >>> and <<<.`,
  {
    query: z.string().describe('Search keywords (e.g., "RSU withholding", "tax filing deadline")'),
    limit: z.number().default(10).describe('Maximum results to return'),
  },
  async (args) => {
    const db = openSearchDb();
    if (!db) {
      return {
        content: [{ type: 'text' as const, text: 'Conversation search is not available (database not found).' }],
        isError: true,
      };
    }

    try {
      const escaped = fts5Escape(args.query);
      if (!escaped) {
        return { content: [{ type: 'text' as const, text: 'Please provide search keywords.' }] };
      }

      const results = db.prepare(`
        SELECT
          m.sender_name,
          m.chat_jid,
          m.timestamp,
          snippet(messages_fts, 0, '>>>', '<<<', '...', 50) as snippet,
          rank
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE messages_fts MATCH ?
          AND m.chat_jid = ?
        ORDER BY rank
        LIMIT ?
      `).all(escaped, chatJid, args.limit) as Array<{
        sender_name: string;
        chat_jid: string;
        timestamp: string;
        snippet: string;
        rank: number;
      }>;

      if (results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No conversations found matching "${args.query}". Try different keywords.`
          }],
        };
      }

      const formatted = results.map((r, i) => {
        const time = new Date(r.timestamp).toLocaleDateString();
        return `**${i + 1}. ${r.sender_name}** (${time})\n${r.snippet}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Found ${results.length} conversation(s) matching "${args.query}":\n\n${formatted}`
        }],
      };
    } finally {
      db.close();
    }
  },
);

server.tool(
  'semantic_search',
  `Search documents by meaning/concept rather than exact keywords.
Use this when keyword search doesn't find what you need, or when the query uses different words than the document.
Example: searching "how much did I earn" can find "Wages: $85,000" even though the words differ.
This is slower than search_documents (~2-5 seconds) but finds conceptually related content.`,
  {
    query: z.string().describe('Natural language query (e.g., "rental property expenses", "total earnings")'),
    limit: z.number().default(5).describe('Maximum results to return'),
  },
  async (args) => {
    const RESULTS_DIR = path.join(IPC_DIR, 'results');

    const searchId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Write search request as IPC task
    const data = {
      type: 'semantic_search',
      query: args.query,
      groupFolder,
      limit: args.limit,
      searchId,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for result
    const resultPath = path.join(RESULTS_DIR, `${searchId}.json`);
    const maxWait = 15000; // 15 seconds
    const pollInterval = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          // Clean up result file
          try { fs.unlinkSync(resultPath); } catch { /* ignore */ }

          if (result.error) {
            return {
              content: [{ type: 'text' as const, text: `Semantic search error: ${result.error}` }],
              isError: true,
            };
          }

          if (!result.results || result.results.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `No semantically similar content found for "${args.query}". Try search_documents for keyword matching.`
              }],
            };
          }

          const formatted = result.results.map((r: { file_name: string; page_number: number | null; content: string; score: number }, i: number) => {
            const page = r.page_number ? ` (page ${r.page_number})` : '';
            const score = `[similarity: ${r.score}]`;
            // Truncate content to ~200 chars for display
            const preview = r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content;
            return `**${i + 1}. ${r.file_name}**${page} ${score}\n${preview}`;
          }).join('\n\n');

          return {
            content: [{
              type: 'text' as const,
              text: `Found ${result.results.length} semantically similar result(s):\n\n${formatted}`
            }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Failed to read search results: ${err}` }],
            isError: true,
          };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{
        type: 'text' as const,
        text: 'Semantic search timed out. The embedding service may not be running. Keyword search (search_documents) is still available.'
      }],
      isError: true,
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
