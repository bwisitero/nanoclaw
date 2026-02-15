# Adding Gmail Access for a New User/Group

Each user or group can have their own Gmail account configured. This guide shows how to set it up.

## Prerequisites

1. The user's Google account must be added as a **Test User** in Google Cloud Console:
   - Go to: https://console.cloud.google.com/apis/credentials/consent
   - Under "Test users", click "ADD USERS"
   - Add the user's Gmail address
   - Click "SAVE"

2. You need the OAuth helper script at `/tmp/get_google_refresh_token.py`

## Step-by-Step Process

### 1. Register the User's Chat (if not already done)

For Telegram:
- User sends `/chatid` to the bot
- Copy their chat ID (e.g., `tg:123456789`)
- Register in `data/registered_groups.json`

### 2. Get the User's Refresh Token

The user (or you on their behalf) runs:

```bash
source /tmp/oauth-env/bin/activate
python3 /tmp/get_google_refresh_token.py \
  --client-id "YOUR_CLIENT_ID.apps.googleusercontent.com" \
  --client-secret "YOUR_CLIENT_SECRET"
```

**Important:** Log in with **THEIR Gmail account** during the OAuth flow.

The script outputs:
```
GOOGLE_WORKSPACE_REFRESH_TOKEN=1//06abc...xyz
```

### 3. Add Token to Their settings.json

Edit `data/sessions/{their-folder}/.claude/settings.json`:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "uvx",
      "args": ["--from", "google-workspace-mcp", "google-workspace-worker"],
      "env": {
        "GOOGLE_WORKSPACE_CLIENT_ID": "${GOOGLE_WORKSPACE_CLIENT_ID}",
        "GOOGLE_WORKSPACE_CLIENT_SECRET": "${GOOGLE_WORKSPACE_CLIENT_SECRET}",
        "GOOGLE_WORKSPACE_REFRESH_TOKEN": "1//06abc...xyz",
        "GOOGLE_WORKSPACE_ENABLED_CAPABILITIES": "[\"gmail\", \"calendar\", \"drive\", \"docs\", \"sheets\", \"slides\"]"
      }
    }
  }
}
```

**Important:**
- Put the actual token value, not `${GOOGLE_WORKSPACE_REFRESH_TOKEN}`
- The `ENABLED_CAPABILITIES` variable is **required** - without it, Gmail tools won't be available

### 4. Restart the Service

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 5. Test

Have the user send "Check my inbox" in their chat. They should see their own Gmail.

## Security Notes

- Each group's token is stored in `data/sessions/{folder}/.claude/settings.json`
- Tokens are isolated per-group via container mounts
- Each container only sees its own group's settings.json
- Users cannot access each other's Gmail

## Group Gmail vs Personal Gmail

You can configure:

- **Personal DMs** → Personal Gmail accounts
  - Your DM → `emil.aguinaldo@gmail.com`
  - Jackie's DM → `jackie@gmail.com`

- **Family/Shared Groups** → Shared Gmail account
  - A3 group → `family@gmail.com`

Each needs its own OAuth flow and token.

## Troubleshooting

**"Access blocked: App not verified"**
- Add the user's email to Test Users in Google Cloud Console

**"No refresh token returned"**
- User may have already authorized the app
- Go to https://myaccount.google.com/permissions
- Remove access for "Frankie Assistant"
- Run OAuth script again

**Wrong Gmail account**
- Check which account was used during OAuth flow
- Delete the token from settings.json
- Run OAuth again with correct account

## Current Configuration

- **main** (Emil's DM): `emil.aguinaldo@gmail.com` ✅ Configured
- **mark** (Mark's DM): Empty (needs OAuth)
- **a3** (Family group): Empty (needs OAuth)

To add Gmail for mark or a3:
1. Decide which Gmail account they should use
2. Add that Gmail to Test Users in GCP Console
3. Run OAuth flow with that account
4. Update their settings.json

---

## Lessons Learned (Feb 15, 2026)

We debugged Gmail integration for 4 hours and discovered critical issues. **Read this to avoid repeating mistakes:**

### Critical Requirements

1. **GOOGLE_WORKSPACE_ENABLED_CAPABILITIES is REQUIRED**
   - Without it, MCP loads but exposes NO tools
   - Add to settings.json: `"GOOGLE_WORKSPACE_ENABLED_CAPABILITIES": "[\"gmail\", \"calendar\", \"drive\", \"docs\", \"sheets\", \"slides\"]"`

2. **Agent-runner must explicitly load CLAUDE.md for main group**
   - Bug fixed in container/agent-runner/src/index.ts
   - Without this, agent ignores CLAUDE.md instructions

3. **MCP's delete function won't work with gmail.modify scope**
   - Use custom gmail-bulk-trash.py script instead
   - MCP requires gmail.delete (permanent), we use gmail.modify (trash)

### Full Retrospective

See `docs/RETROSPECTIVE_GMAIL_INTEGRATION.md` for complete timeline, mistakes made, and prevention strategies.

**Key Takeaway**: Explicit is better than implicit. Never rely on auto-detection for critical functionality.
