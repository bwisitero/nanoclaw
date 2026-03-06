# Gmail Authentication Fix

## Issue
Gmail authentication was failing with "OAuth token expired" errors because the settings.json file contained a hardcoded, outdated refresh token.

## Root Cause
`data/sessions/main/.claude/settings.json` had:
```json
"GOOGLE_WORKSPACE_REFRESH_TOKEN": "1//067zVy_uFf5pGCgYIARAAGAY..."
```

This hardcoded token was old and no longer valid.

## Solution
Changed settings.json to use environment variable instead:
```json
"GOOGLE_WORKSPACE_REFRESH_TOKEN": "${GOOGLE_WORKSPACE_REFRESH_TOKEN}"
```

This reads the current token from `.env` file, which is managed separately and not committed to git.

## Steps to Fix (if this happens again)

1. Edit `data/sessions/main/.claude/settings.json`
2. Find the `google-workspace` MCP server config
3. Change the refresh token line from hardcoded value to:
   ```json
   "GOOGLE_WORKSPACE_REFRESH_TOKEN": "${GOOGLE_WORKSPACE_REFRESH_TOKEN}"
   ```
4. Restart NanoClaw service:
   ```bash
   launchctl stop com.nanoclaw
   launchctl start com.nanoclaw
   ```

## Preventing Future Issues

- Keep `.env` file up to date with valid Google OAuth tokens
- Never hardcode tokens in settings.json - always use `${VAR}` syntax
- If token expires, generate new one via Google OAuth Playground

## Testing
After fix:
```
# In Telegram, send:
check my email
```

Should work without OAuth errors.

## Fixed Date
2026-03-06

## Status
✅ Resolved - Gmail authentication working
