# Setup Skill

**Triggers:** setup, install, configure nanoclaw, first time setup

## Description

Interactive setup wizard for first-time NanoClaw installation. Guides users through:
- API key configuration
- WhatsApp authentication
- Container build
- Service configuration
- Optional integrations

## Instructions

When the user asks to set up NanoClaw, run this guided setup process:

### Step 1: Check Prerequisites

Check if the following are installed:

```bash
node --version  # Need 20+
npm --version
container --version || docker --version  # Need one of these
```

If missing, tell the user what's missing and how to install it.

### Step 2: Environment Configuration

Check if `.env` file exists:

```bash
test -f /workspace/project/.env && echo "exists" || echo "missing"
```

If missing, create from template:

```bash
cp /workspace/project/.env.example /workspace/project/.env
```

Then guide the user through required configuration:

**Required: Anthropic API Key**

1. Ask user if they have an Anthropic API key
2. If no, send them to: https://console.anthropic.com/settings/keys
3. Tell them to create a key and paste it when ready
4. Update `.env` file with their key

**Required: Tavily API Key**

1. Ask user if they have a Tavily API key (for web search)
2. If no, send them to: https://tavily.com (free tier available)
3. Tell them to sign up and paste the key when ready
4. Update `.env` file with their key

**Optional: Google Workspace**

1. Ask if they want Gmail integration
2. If yes, point them to the full guide: `/workspace/project/docs/SETUP.md#google-workspace-setup`
3. Let them know they can skip this for now and add later

### Step 3: Build the Project

```bash
cd /workspace/project
npm install
npm run build
```

Show progress and handle any errors.

### Step 4: Container Setup

Detect which container runtime is available:

```bash
if command -v container &> /dev/null; then
    echo "Using Apple Container"
    RUNTIME="container"
elif command -v docker &> /dev/null; then
    echo "Using Docker"
    RUNTIME="docker"
else
    echo "ERROR: No container runtime found"
    exit 1
fi
```

Build the container:

```bash
cd /workspace/project
./container/build.sh
```

This takes 1-2 minutes. Show progress.

### Step 5: WhatsApp Authentication

Tell the user you're about to start the service and they'll need to scan a QR code.

Start the service temporarily:

```bash
cd /workspace/project
npm run dev
```

The QR code will appear in the terminal.

**Instructions for user:**
1. Open WhatsApp on your phone
2. Go to Settings → Linked Devices
3. Tap "Link a Device"
4. Scan the QR code shown in the terminal

Wait for "WhatsApp connected" message, then stop the dev server (Ctrl+C).

### Step 6: Service Configuration (macOS only)

If on macOS, set up launchd for auto-start:

```bash
# Create launchd directory if it doesn't exist
mkdir -p ~/Library/LaunchAgents

# Copy and update plist
cp /workspace/project/launchd/com.nanoclaw.plist ~/Library/LaunchAgents/

# Load the service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**For Linux users:**
Point them to systemd service setup in the docs (TODO: create this).

### Step 7: Test the Installation

Tell the user to send a test message to themselves on WhatsApp:

```
@Andy hello
```

(Use the actual trigger word from their config)

Wait for them to confirm it works.

### Step 8: Next Steps

Congratulate them and provide next steps:

**Customize your assistant:**
```bash
nano /workspace/project/groups/main/CLAUDE.md
```

**Available features:**
- Upload documents (PDFs, CSVs, images) for search
- Schedule tasks: "@Andy remind me to..."
- Add Telegram: "@Andy add Telegram support"
- Add voice transcription: "@Andy add voice transcription"

**Resources:**
- Full setup guide: `/workspace/project/docs/SETUP.md`
- Architecture: `/workspace/project/README.md`
- Need help? Just ask: "@Andy how do I..."

## Error Handling

**If npm install fails:**
- Check Node.js version (need 20+)
- Try `npm cache clean --force` then retry

**If container build fails:**
- For Docker: `docker builder prune -a` then rebuild
- For Apple Container: `container builder stop && container builder rm && container builder start` then rebuild

**If WhatsApp won't connect:**
- Make sure phone has internet
- Try closing and reopening WhatsApp on phone
- Check firewall isn't blocking the connection
- Try again with `npm run dev`

**If service won't start:**
- Check logs: `tail -f /workspace/project/logs/nanoclaw.log`
- Verify .env has correct API keys
- Try manual start: `cd /workspace/project && npm start`

## Notes

- This skill should be run from the **main channel** (user's self-chat)
- The process takes 5-10 minutes total
- User will need their phone nearby for WhatsApp QR code
- API keys can be added later if user wants to try without web search first
- Be encouraging and helpful - this is their first experience!
