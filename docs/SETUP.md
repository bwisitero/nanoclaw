# NanoClaw Setup Guide

Complete setup guide for getting NanoClaw running on your machine.

## Prerequisites

- **macOS** (Apple Silicon or Intel) or **Linux**
- **Node.js** 20+ (`node --version`)
- **Container runtime**:
  - macOS: Apple Container (built-in) or Docker Desktop
  - Linux: Docker
- **Git**

## Step 1: Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/nanoclaw.git
cd nanoclaw
npm install
```

## Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your API keys:

### Required: Anthropic API Key

1. Go to https://console.anthropic.com/settings/keys
2. Create a new API key
3. Add to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

### Required: Web Search API Key

1. Go to https://tavily.com
2. Sign up (free tier: 1000 searches/month)
3. Get your API key
4. Add to `.env`:
   ```
   TAVILY_API_KEY=tvly-...
   ```

### Optional: Google Workspace (Gmail, Calendar, Drive)

Only needed if you want Gmail integration. See [Google Workspace Setup](#google-workspace-setup) below.

## Step 3: Build

```bash
npm run build
```

## Step 4: Container Setup

### Option A: Apple Container (macOS only, recommended)

Already installed on macOS 13+. Verify:

```bash
container --version
```

Build the agent container:

```bash
./container/build.sh
```

### Option B: Docker (macOS/Linux)

Install Docker Desktop: https://www.docker.com/products/docker-desktop

Build the agent container:

```bash
./container/build.sh
```

## Step 5: WhatsApp Authentication

Start the service temporarily to authenticate WhatsApp:

```bash
npm run dev
```

You'll see a QR code in the terminal. Scan it with WhatsApp:

1. Open WhatsApp on your phone
2. Go to **Settings** → **Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code

Once connected, press `Ctrl+C` to stop the dev server.

## Step 6: Configure Service (macOS)

Set up launchd for auto-start:

```bash
# Create launchd plist
mkdir -p ~/Library/LaunchAgents

# Update paths in the plist
sed "s|/Users/YOUR_USERNAME|$HOME|g" launchd/com.nanoclaw.plist > ~/Library/LaunchAgents/com.nanoclaw.plist

# Load the service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

The service will now:
- Start automatically on login
- Restart if it crashes
- Auto-restart when code changes (via `npm run build`)

## Step 7: Test

Send a message to yourself on WhatsApp:

```
@Andy hello
```

(Replace `@Andy` with your configured trigger word)

You should get a response!

## Step 8: Configure Your Assistant

Edit your assistant's behavior:

```bash
nano groups/main/CLAUDE.md
```

Set:
- Assistant name
- Timezone
- Personality
- Custom instructions

## Optional Setup

### Google Workspace Setup

For Gmail, Calendar, Drive integration:

1. **Create Google Cloud Project**
   - Go to https://console.cloud.google.com
   - Create a new project
   - Enable Gmail API, Calendar API, Drive API

2. **Create OAuth Credentials**
   - Go to **APIs & Services** → **Credentials**
   - Create **OAuth 2.0 Client ID** (Desktop app)
   - Download credentials JSON

3. **Get Refresh Token**
   - Go to https://developers.google.com/oauthplayground
   - Click gear icon (⚙️) → "Use your own OAuth credentials"
   - Enter your Client ID and Client Secret
   - Select scopes:
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar`
     - `https://www.googleapis.com/auth/drive`
   - Authorize and exchange for tokens
   - Copy the **Refresh Token**

4. **Update .env**
   ```bash
   GOOGLE_WORKSPACE_CLIENT_ID=your-client-id
   GOOGLE_WORKSPACE_CLIENT_SECRET=your-client-secret
   GOOGLE_WORKSPACE_REFRESH_TOKEN=1//0...
   ```

5. **Restart service**
   ```bash
   launchctl stop com.nanoclaw
   launchctl start com.nanoclaw
   ```

### Telegram Setup

To add Telegram alongside or instead of WhatsApp:

```
@Andy I want to add Telegram support
```

Then follow the agent's guided setup.

### Voice Transcription

To transcribe WhatsApp voice messages:

```
@Andy add voice transcription support
```

### Local Embedding Service

For semantic document search (optional, uses local ONNX model):

```bash
cd services/embedding-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Start service (runs on port 3001)
python server.py
```

Add to launchd for auto-start:
```bash
cp launchd/com.nanoclaw.embedding.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.embedding.plist
```

## Troubleshooting

### WhatsApp disconnects frequently

Check logs:
```bash
tail -f logs/nanoclaw.log
```

### Container fails to build

Clear Docker cache:
```bash
container builder stop
container builder rm
container builder start
./container/build.sh
```

Or for Docker:
```bash
docker builder prune -a
./container/build.sh
```

### "No container runtime found"

Install Docker Desktop or verify Apple Container is available:
```bash
container --version  # macOS
docker --version     # macOS/Linux
```

### Gmail authentication fails

See [docs/GMAIL_AUTH_FIX.md](GMAIL_AUTH_FIX.md)

### Service not starting

Check launchd status:
```bash
launchctl list | grep nanoclaw
```

View service logs:
```bash
tail -f ~/Library/Logs/nanoclaw.stdout.log
tail -f ~/Library/Logs/nanoclaw.stderr.log
```

## Service Management

```bash
# Start service
launchctl start com.nanoclaw

# Stop service
launchctl stop com.nanoclaw

# Restart service
launchctl stop com.nanoclaw && launchctl start com.nanoclaw

# Unload service (disable auto-start)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Reload service (after editing plist)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Development Workflow

```bash
# Make code changes
nano src/index.ts

# Build (service auto-restarts via launchd WatchPaths)
npm run build

# Or run in dev mode (hot reload)
npm run dev
```

## Next Steps

- Customize your assistant in `groups/main/CLAUDE.md`
- Add scheduled tasks: `@Andy remind me to...`
- Upload documents for search: Just send PDFs/CSVs/images to your chat
- Create custom skills: `@Andy create a skill that...`
- Join group chats and register them: `@Andy join this group`

## Need Help?

Ask your assistant! The codebase is small enough that Claude can debug, explain, and fix issues:

```
@Andy why did the service crash?
@Andy explain how container isolation works
@Andy add a feature that...
```

## Security Notes

- `.env` contains secrets - never commit it to git
- `data/` contains your messages and OAuth tokens - gitignored
- `store/` contains your conversation database - gitignored
- Each group runs in an isolated container with only its own files mounted
- Main channel has elevated privileges - keep it private

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Host (your Mac/Linux machine)                      │
│                                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │  NanoClaw Process (Node.js)                  │  │
│  │  - WhatsApp/Telegram connection              │  │
│  │  - Message routing                            │  │
│  │  - Container orchestration                    │  │
│  │  - SQLite database (messages, costs, tasks)  │  │
│  └──────────────────────────────────────────────┘  │
│                       │                              │
│                       ▼                              │
│  ┌──────────────────────────────────────────────┐  │
│  │  Container (ephemeral, per-message)          │  │
│  │  - Claude Agent SDK                           │  │
│  │  - MCP servers (web search, Gmail, etc.)     │  │
│  │  - Isolated filesystem (only group files)    │  │
│  │  - Pre-compiled TypeScript (~1s startup)     │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
└─────────────────────────────────────────────────────┘
```

## Resources

- [Claude Agent SDK Docs](https://code.claude.com/docs)
- [MCP Servers](https://github.com/modelcontextprotocol/servers)
- [Upstream NanoClaw](https://github.com/gavrielc/nanoclaw)
- [Discord Community](https://discord.gg/VGWXrf8x)
