<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  My personal Claude assistant that runs securely in containers. Lightweight and built to be understood and customized for your own needs.
</p>

<p align="center">
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VGWXrf8x"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## About This Fork

This is a production-hardened fork of [NanoClaw](https://github.com/gavrielc/nanoclaw) with 32 commits adding reliability, search, cost tracking, and self-healing on top of the original's clean foundation.

**If you want a minimal starting point** — use [upstream NanoClaw](https://github.com/gavrielc/nanoclaw). WhatsApp, containers, scheduled tasks. Intentionally small.

**If you want something closer to daily-driver ready** — this fork adds the features you'll want after running the base for a week: Telegram, document search, progress indicators, quiet hours, auto-reconnect, health monitoring, cost visibility, and security hardening.

### What This Fork Adds Over Upstream NanoClaw

| Category | Upstream NanoClaw | This Fork |
|----------|------------------|-----------|
| **Channels** | WhatsApp only | WhatsApp + Telegram (with agent swarm bot pool) |
| **Search** | None | Full-text (FTS5) + semantic search with local embeddings |
| **Documents** | None | PDF/CSV/image upload, extraction, chunking, indexing |
| **Progress** | Silent until done | Live tool-by-tool progress indicators |
| **Cost** | None | Per-interaction token/USD tracking with history |
| **Scheduling** | Basic cron/interval | + Quiet hours (suppress during sleep) |
| **Reliability** | Manual restart on failure | Auto-reconnect, liveness probes, health check every 5 min |
| **Self-healing** | None | Agent can edit source + `npm run build` → launchd auto-restarts |
| **Security** | Container isolation | + Path traversal guards, cross-group validation, symlink detection, cryptographic task IDs |
| **Performance** | TSC on every container start | Pre-compiled TypeScript, fs.watch IPC, skills mounted not copied |
| **Integrations** | Skills only | Gmail, voice transcription, Google Workspace MCP built-in |
| **Container startup** | ~2s (recompiles TypeScript) | ~1s (pre-built, recompiles only if source is newer) |

Everything from upstream works here. The fork stays mergeable — features are additive, not rewrites.

## Why NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project with a great vision. But I can't sleep well running software I don't understand with access to my life. OpenClaw has 52+ modules, 8 config management files, 45+ dependencies, and abstractions for 15 channel providers. Security is application-level (allowlists, pairing codes) rather than OS isolation. Everything runs in one Node process with shared memory.

NanoClaw gives you the same core functionality in a codebase you can understand in 8 minutes. One process. A handful of files. Agents run in actual Linux containers with filesystem isolation, not behind permission checks.

## Quick Start

### Option 1: Guided Setup (Recommended)

```bash
git clone https://github.com/YOUR_USERNAME/nanoclaw.git
cd nanoclaw
npm install
npm run build
```

Then message yourself on WhatsApp and say:
```
@Andy /setup
```

The interactive setup wizard will guide you through everything.

### Option 2: Manual Setup

See the complete step-by-step guide: **[docs/SETUP.md](docs/SETUP.md)**

**What you'll need:**
- Anthropic API key (get from [console.anthropic.com](https://console.anthropic.com))
- Tavily API key for web search (get from [tavily.com](https://tavily.com))
- 5-10 minutes to complete setup

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers. Have Claude Code walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker). They can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for one user.** This isn't a framework. It's working software that fits my exact needs. You fork it and have Claude Code make it match your exact needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that this is safe.

**AI-native.** No installation wizard; Claude Code guides setup. No monitoring dashboard; ask Claude what's happening. No debugging tools; describe the problem, Claude fixes it.

**Skills over features.** Contributors shouldn't add features (e.g. support for Telegram) to the codebase. Instead, they contribute [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** This runs on Claude Agent SDK, which means you're running Claude Code directly. The harness matters. A bad harness makes even smart models seem dumb, a good harness gives them superpowers. Claude Code is (IMO) the best harness available.

## What It Supports

- **WhatsApp + Telegram** - Message Claude from your phone or desktop. Telegram support via `/add-telegram` skill
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted
- **Main channel** - Your private channel (self-chat) for admin control; every other group is completely isolated
- **Scheduled tasks with quiet hours** - Recurring jobs with cron/interval scheduling. Quiet hours suppress tasks during sleep (e.g. 22:00-07:00)
- **Document & conversation search** - Upload PDFs, CSVs, images. Full-text keyword search (FTS5) and semantic search with local embeddings (all-MiniLM-L6-v2, no external API)
- **Web access** - Search (Tavily) and fetch content
- **Live progress indicators** - See what the agent is doing in real-time (tool names shown as the agent works)
- **Cost tracking** - Per-interaction token usage and USD cost displayed after each response. Historical cost data per group
- **Container isolation** - Agents sandboxed in Apple Container (macOS) or Docker (macOS/Linux). Pre-compiled TypeScript for fast container startup
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks (first personal AI assistant to support this)
- **Self-healing** - Auto-reconnect on channel disconnection with exponential backoff. Liveness probes detect silent failures. Health check monitors channels, database, and container health every 5 minutes. Main agent can edit source code and trigger auto-restart via launchd WatchPaths
- **Security hardening** - Path traversal protection on IPC file operations, cross-group request validation, mount symlink detection, cryptographic task IDs
- **Optional integrations** - Add Gmail (`/add-gmail`), Telegram (`/add-telegram`), voice transcription (`/add-voice-transcription`), and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

There are no configuration files to learn. Just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd love to see:

**Communication Channels**
- `/add-slack` - Add Slack
- `/add-discord` - Add Discord
- `/add-signal` - Add Signal

**Platform Support**
- `/setup-windows` - Windows via WSL2 + Docker

**Session Management**
- `/add-clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

**Already Implemented** (available as skills):
- `/add-telegram` - Telegram as additional or replacement channel with agent swarm support
- `/add-gmail` - Gmail integration with per-user OAuth isolation
- `/add-voice-transcription` - Whisper-based voice message transcription

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels (WhatsApp/Telegram) --> SQLite --> Message loop --> Container (Claude Agent SDK) --> Response
                                              |                    |
                                         Health check         IPC (fs.watch)
                                         Task scheduler       MCP tools
                                         Document indexer     Progress streaming
```

Single Node.js process. Agents execute in isolated Linux containers with mounted directories. Per-group message queue with concurrency control. IPC via filesystem with `fs.watch` for low-latency detection.

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation, health check
- `src/channels/whatsapp.ts` - WhatsApp connection, auth, send/receive, reconnect
- `src/channels/telegram.ts` - Telegram bot, liveness probe, auto-reconnect
- `src/ipc.ts` - IPC watcher (fs.watch + fallback poll) and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers with progress markers
- `src/task-scheduler.ts` - Scheduled tasks with quiet hours support
- `src/db.ts` - SQLite operations (messages, groups, sessions, state, costs, document search)
- `src/document-processor.ts` - PDF/CSV/image extraction, chunking, embedding
- `src/embedding-client.ts` - Local ONNX embedding service (all-MiniLM-L6-v2)
- `src/mount-security.ts` - Mount allowlist validation with symlink detection
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why WhatsApp and not Telegram/Signal/etc?**

Both WhatsApp and Telegram are supported out of the box. Run `/add-telegram` to add Telegram, or set `TELEGRAM_ONLY=true` to skip WhatsApp entirely. Want Signal or Slack? Fork it and run a skill to add them.

**Why Apple Container instead of Docker?**

On macOS, Apple Container is lightweight, fast, and optimized for Apple silicon. But Docker is also fully supported—during `/setup`, you can choose which runtime to use. On Linux, Docker is used automatically.

**Can I run this on Linux?**

Yes. Run `/setup` and it will automatically configure Docker as the container runtime. Thanks to [@dotsetgreg](https://github.com/dotsetgreg) for contributing the `/convert-to-docker` skill.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize it to so that the code matches exactly what they want rather than configuring a generic system. If you like having config files, tell Claude to add them.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach.

**Why isn't the setup working for me?**

I don't know. Run `claude`, then run `/debug`. If claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Security fixes, bug fixes, and clear improvements to the base configuration. That's it.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VGWXrf8x).

## License

MIT
