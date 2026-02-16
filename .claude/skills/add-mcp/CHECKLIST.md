# MCP Installation Checklist

When adding a new MCP server, ALWAYS complete ALL steps in order:

## Step 1: Add API Keys to `.env`

```bash
# Example for Slack MCP
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_APP_TOKEN=xapp-your-token-here
```

**Location:** `/Users/emil/Documents/NanoClaw/nanoclaw/.env`

---

## Step 2: Add Keys to `allowedVars` in `container-runner.ts`

```typescript
const allowedVars = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'TAVILY_API_KEY',
  'GOOGLE_WORKSPACE_CLIENT_ID',
  'GOOGLE_WORKSPACE_CLIENT_SECRET',
  'GOOGLE_WORKSPACE_REDIRECT_URI',
  // ADD NEW VARS HERE
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
];
```

**Location:** `src/container-runner.ts` (around line 256)

---

## Step 3: Add MCP Server to Default Template

**⚠️ CRITICAL: MUST include `env` section with all required credentials**

**Location:** `src/container-runner.ts` (around line 153-165)

**Example - Look at Tavily's pattern:**
```typescript
tavily: {
  command: 'npx',
  args: ['-y', '@tavily/mcp-server'],
  env: {
    TAVILY_API_KEY: '${TAVILY_API_KEY}',  // ← MUST HAVE THIS
  },
},
```

**Add new MCP following the same pattern:**
```typescript
'slack': {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-slack'],
  env: {
    SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}',      // ← MUST HAVE THIS
    SLACK_APP_TOKEN: '${SLACK_APP_TOKEN}',      // ← MUST HAVE THIS
  },
},
```

**Common patterns:**
- `npx` for npm packages: `npx -y @scope/package`
- `uvx` for Python packages: `uvx --from package-name executable-name`

---

## Step 4: Update Existing Groups' Settings

Each existing group needs the MCP added to their settings.json:

**Files to update:**
- `data/sessions/main/.claude/settings.json`
- `data/sessions/mark/.claude/settings.json`
- `data/sessions/a3/.claude/settings.json`
- Any other groups in `data/sessions/*/`

**Add to `mcpServers` section in each file:**
```json
"slack": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-slack"],
  "env": {
    "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
    "SLACK_APP_TOKEN": "${SLACK_APP_TOKEN}"
  }
}
```

---

## Step 5: Rebuild

```bash
npm run build
```

This will:
- Compile TypeScript
- Run validation script (catches missing config)

---

## Step 6: Restart Service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Wait 3 seconds for startup**, then check logs:
```bash
tail -20 logs/nanoclaw.log
```

Look for: `Telegram bot connected` and `NanoClaw running`

---

## Step 7: Test with Message

Send a test message that uses the new MCP:

**Example for Slack:**
```
List my Slack channels
```

**Check container logs:**
```bash
docker ps --filter "name=nanoclaw-main" --format "{{.Names}}"
docker logs <container-name> 2>&1 | grep -i "slack\|mcp\|Loaded"
```

**Expected output:**
```
[agent-runner] Loaded 3 MCP server(s) from settings.json: tavily, google-workspace, slack
```

---

## Common Mistakes to Avoid

❌ **Forgetting the `env` section** (most common)
  - MCP server defined but no credentials passed
  - Results in: "API_KEY is required but not set" errors

❌ **Typo in environment variable name**
  - `SLACK_BOT_TOKNE` vs `SLACK_BOT_TOKEN`
  - Variable in .env doesn't match what's in env section

❌ **Not updating existing groups**
  - New template works for new groups
  - Existing groups still use old settings.json

❌ **Wrong command/args**
  - Check the MCP's documentation for correct installation
  - npm packages: `npx -y @scope/package`
  - Python packages: `uvx --from package executable`

---

## Quick Reference: Current MCPs

| MCP | Command | Env Vars |
|-----|---------|----------|
| Tavily (Web Search) | `npx -y @tavily/mcp-server` | `TAVILY_API_KEY` |
| Google Workspace | `uvx --from google-workspace-mcp google-workspace-worker` | `GOOGLE_WORKSPACE_CLIENT_ID`<br>`GOOGLE_WORKSPACE_CLIENT_SECRET`<br>`GOOGLE_WORKSPACE_REDIRECT_URI` |

---

## Validation

After Steps 1-4, run:
```bash
npm run validate-mcp
```

This checks:
- ✅ All env vars in MCP configs exist in `.env`
- ✅ All env vars in `.env` are in `allowedVars`
- ✅ All MCP configs have `env` sections (when needed)
- ✅ No orphaned env vars

If validation passes, proceed to Step 5 (rebuild).
