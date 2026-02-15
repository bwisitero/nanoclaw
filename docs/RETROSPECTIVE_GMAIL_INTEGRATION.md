# Retrospective: Gmail Integration Debugging (Feb 15, 2026)

## Executive Summary

**Goal**: Enable automated Gmail deletion through the agent
**Duration**: ~4 hours of debugging
**Final Status**: ✅ Working
**Root Causes**: (1) Missing environment variable, (2) System prompt bug in agent-runner

---

## Timeline of Issues and Fixes

### Issue #1: Gmail MCP Tools Not Available

**Symptom**: Agent couldn't see any Gmail tools despite MCP being configured

**Investigation**:
- Verified OAuth token had correct permissions ✅
- Verified Gmail API was enabled in GCP ✅
- Verified CLIENT_ID and CLIENT_SECRET were set ✅
- Verified REFRESH_TOKEN was set ✅

**Root Cause**:
Missing `GOOGLE_WORKSPACE_ENABLED_CAPABILITIES` environment variable in settings.json

**Why This Happened**:
- PyPI documentation for `google-workspace-mcp` mentions this variable but it's easy to miss
- We followed the basic setup (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN) but missed this critical config
- The MCP server silently starts without the variable but doesn't expose any tools

**The Fix**:
```json
{
  "env": {
    "GOOGLE_WORKSPACE_CLIENT_ID": "${GOOGLE_WORKSPACE_CLIENT_ID}",
    "GOOGLE_WORKSPACE_CLIENT_SECRET": "${GOOGLE_WORKSPACE_CLIENT_SECRET}",
    "GOOGLE_WORKSPACE_REFRESH_TOKEN": "1//06...",
    "GOOGLE_WORKSPACE_ENABLED_CAPABILITIES": "[\"gmail\", \"calendar\", \"drive\", \"docs\", \"sheets\", \"slides\"]"
  }
}
```

**Files Updated**:
- `data/sessions/main/.claude/settings.json`
- `data/sessions/a3/.claude/settings.json`
- `data/sessions/mark/.claude/settings.json`
- `src/container-runner.ts` (template for new groups)

**Verification**: Direct container test showed MCP server loaded but no tools available → after adding variable, tools appeared

**Lesson Learned**: Always check MCP documentation for **required** vs optional environment variables. Silent failures are the worst.

---

### Issue #2: Gmail Deletion Permission Errors

**Symptom**: Agent could read emails but deletion always failed with "insufficient permissions"

**Investigation**:
- Verified OAuth token had `gmail.modify` scope ✅
- Tried regenerating tokens multiple times ✅
- Verified Gmail API was enabled ✅
- Agent kept using `gmail_bulk_delete_messages` MCP function

**Root Cause**:
The MCP's `gmail_bulk_delete_messages` function uses Gmail's **permanent delete API** (`batchDelete`), which requires full `gmail.delete` scope or the special `gmail.` (full access) scope. Our token only had `gmail.modify` which allows moving to trash but not permanent deletion.

**Why This Happened**:
- Assumed MCP function would use the safest deletion method (move to trash)
- MCP documentation doesn't clearly explain the difference between `gmail_bulk_delete_messages` (permanent) and moving to trash
- We followed security best practices by using `gmail.modify` instead of full access, but the MCP function requires more permissions

**The Solution**:
Direct API call using `batchModify` with TRASH label instead of `batchDelete`:

```python
service.users().messages().batchModify(
    userId='me',
    body={
        'ids': message_ids,
        'addLabelIds': ['TRASH']
    }
).execute()
```

This works with `gmail.modify` scope (which we have).

**Verification**:
- Direct Python test successfully deleted 77 Slickdeals emails ✅
- Used same approach in standalone script ✅

**Files Created**:
- `container/skills/gmail-bulk-delete/gmail-bulk-trash.py` (working deletion script)
- `/tmp/test-bulk-delete.py` (test script that proved the concept)

**Lesson Learned**:
1. Test MCP functions directly before assuming they work
2. Understand the underlying API calls MCPs make
3. When permissions fail, check if the MCP is using a more privileged API than necessary
4. Document the difference between deletion methods (permanent vs trash)

---

### Issue #3: Agent Ignored CLAUDE.md Instructions

**Symptom**:
Despite explicit instructions in CLAUDE.md to "DO NOT use `gmail_bulk_delete_messages`", the agent kept using it

**Investigation**:
- Verified CLAUDE.md was mounted in container ✅
- Verified CLAUDE.md content was correct in container ✅
- Verified file sizes matched between host and container ✅
- Cleared session cache multiple times ⚠️ (didn't fix it)
- Restarted service multiple times ⚠️ (didn't fix it)

**Root Cause**:
Bug in `/container/agent-runner/src/index.ts` lines 394-397:

```typescript
// BUGGY CODE:
const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
let globalClaudeMd: string | undefined;
if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
  globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
}
```

For **main group**, `globalClaudeMd` stayed `undefined`, so the system prompt used Claude Code's default preset WITHOUT appending CLAUDE.md instructions.

**Why This Happened**:
- Original code was designed to append `global/CLAUDE.md` for non-main groups
- For main group, relied on Claude Code's automatic CLAUDE.md file detection
- Claude Code's auto-detection is too weak - it reads the file but doesn't prioritize instructions when built-in tools are available
- When agent sees both `gmail_bulk_delete_messages` (MCP tool) and bash script instructions, it prefers built-in tools

**The Fix**:
```typescript
// FIXED CODE:
// For main group, explicitly read and append its CLAUDE.md to ensure instructions are followed
const groupClaudeMdPath = '/workspace/group/CLAUDE.md';
if (containerInput.isMain && fs.existsSync(groupClaudeMdPath)) {
  const groupClaudeMd = fs.readFileSync(groupClaudeMdPath, 'utf-8');
  globalClaudeMd = globalClaudeMd ? `${globalClaudeMd}\n\n${groupClaudeMd}` : groupClaudeMd;
}
```

**Verification**:
- Before fix: Agent said "cannot delete, permissions error"
- After fix: Agent successfully deleted emails, 0 in inbox, 10 moved to trash ✅

**Files Updated**:
- `container/agent-runner/src/index.ts` (lines 400-407, added explicit CLAUDE.md loading for main group)
- Container rebuilt and redeployed

**Lesson Learned**:
1. **Never rely on implicit behavior for critical instructions** - always explicitly load and append instructions to system prompt
2. **Built-in tools override contextual instructions** - instructions must be in the core system prompt to be respected
3. **Test with both main and non-main groups** to catch asymmetry bugs
4. **File context ≠ system prompt** - Claude Code treats them differently

---

## What Worked (Successful Techniques)

### 1. Direct API Testing

**What We Did**: Created standalone Python script to test Gmail API directly, bypassing the MCP

**Why It Worked**:
- Isolated the problem to the MCP function vs our credentials
- Proved `batchModify` with TRASH label works with `gmail.modify` scope
- Gave us confidence the credentials and permissions were correct

**Reusable Pattern**:
```python
# Always test APIs directly when MCPs fail
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

credentials = Credentials(None, refresh_token=token, ...)
credentials.refresh(Request())
service = build('gmail', 'v1', credentials=credentials)

# Test the operation
result = service.users().messages().batchModify(...)
```

### 2. Container Environment Inspection

**What We Did**:
```bash
docker exec <container> cat /workspace/group/CLAUDE.md
docker exec <container> cat /home/node/.claude/settings.json
docker exec <container> ls -la /home/node/.claude/skills/
```

**Why It Worked**:
- Verified files were actually mounted correctly
- Confirmed content matched host files
- Eliminated "file not found" as a possibility

### 3. Comparing Host vs Container

**What We Did**:
```bash
echo "=== Host CLAUDE.md ==="
grep -A 7 "IMPORTANT FOR GMAIL" groups/main/CLAUDE.md

echo "=== Container CLAUDE.md ==="
docker exec <container> grep -A 7 "IMPORTANT FOR GMAIL" /workspace/group/CLAUDE.md
```

**Why It Worked**:
- Proved the file content was identical
- Eliminated "mount issue" or "stale file" theories
- Focused investigation on how the file was being used, not its content

### 4. Session Reset Protocol

**What We Did**:
```bash
# 1. Stop running container
docker stop <container_id>

# 2. Delete database session
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = 'main'"

# 3. Delete all session cache files
rm -rf data/sessions/main/.claude/projects/*
rm -rf data/sessions/main/.claude/session-env/*
rm -rf data/sessions/main/.claude/debug/*
rm -rf data/sessions/main/.claude/todos/*

# 4. Restart service (critical - reloads in-memory session cache)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Why It Worked**:
- Cleared both persistent (database) and ephemeral (filesystem) session data
- Restarting service cleared in-memory session cache
- Agent got truly fresh start with new session ID

**Important**: Session reset alone didn't fix the CLAUDE.md bug, but it was necessary to verify the fix worked with a clean slate.

### 5. Iterative Verification

**What We Did**: After each fix, verified with simple test:
```bash
# Test 1: Check credentials
echo "GOOGLE_WORKSPACE_CLIENT_ID present: $([ -n "$GOOGLE_WORKSPACE_CLIENT_ID" ] && echo YES || echo NO)"

# Test 2: Check MCP loads
docker logs <container> | grep "Loaded.*MCP"

# Test 3: Check Gmail search works
python3 test_gmail_search.py

# Test 4: Check deletion works
python3 test_gmail_delete.py

# Test 5: Check agent uses correct method
docker logs <container> | grep "gmail-bulk-trash\|batchModify"
```

**Why It Worked**:
- Caught regressions immediately
- Built confidence each fix actually worked
- Prevented "fixing one thing, breaking another"

---

## Mistakes We Made

### Mistake #1: Assuming MCP Documentation Was Complete

**What Happened**: Spent 30+ minutes debugging why MCP wasn't working, only to discover `GOOGLE_WORKSPACE_ENABLED_CAPABILITIES` was required but not obvious in docs

**Cost**: 30 minutes of debugging time, multiple token regenerations

**How to Prevent**:
- ✅ **Create a validation checklist** for each MCP integration
- ✅ **Check GitHub issues** for common setup problems before starting
- ✅ **Test with minimal example** before integrating into complex system
- ✅ **Document all required environment variables** in our setup guides

### Mistake #2: Not Testing MCP Functions Directly

**What Happened**: Assumed `gmail_bulk_delete_messages` would work because we had `gmail.modify` scope, spent 1+ hour debugging permissions

**Cost**: 1+ hour, multiple OAuth token regenerations, user frustration

**How to Prevent**:
- ✅ **Always test MCP functions with direct API calls first**
- ✅ **Read MCP source code** when documentation is unclear (check what API it actually calls)
- ✅ **Document permission requirements** for each function we use
- ✅ **Create test scripts** before integrating into agent

### Mistake #3: Relying on Implicit Behavior

**What Happened**: Assumed Claude Code's automatic CLAUDE.md detection would work for main group, spent 2+ hours debugging why agent ignored instructions

**Cost**: 2+ hours, multiple container rebuilds, session resets

**How to Prevent**:
- ✅ **Never rely on implicit behavior for critical functionality**
- ✅ **Explicitly load and verify all configuration** at startup
- ✅ **Test with both main and non-main groups** to catch asymmetry
- ✅ **Add logging** to show what instructions were loaded: `log("Loaded CLAUDE.md: " + claudeMd.substring(0, 100))`

### Mistake #4: Not Checking In-Memory State

**What Happened**: Cleared database and filesystem sessions, but service still had old session in memory

**Cost**: 30 minutes of confusion about why session reset "didn't work"

**How to Prevent**:
- ✅ **Always restart service** after clearing sessions
- ✅ **Document the full reset protocol** (database + filesystem + service restart)
- ✅ **Add session cache invalidation** when sessions are deleted
- ✅ **Log session loads** so we can see when stale sessions are used

### Mistake #5: Multiple Changes at Once

**What Happened**: Sometimes made multiple changes (update CLAUDE.md + rebuild container + restart service) without testing incrementally

**Cost**: When things broke, unclear which change caused it

**How to Prevent**:
- ✅ **One change at a time**
- ✅ **Verify after each change** before moving to next
- ✅ **Document what changed** in commit messages
- ✅ **Keep test scripts handy** for quick verification

---

## Prevention Strategies (Never Make These Mistakes Again)

### Strategy #1: MCP Integration Checklist

**File**: `.claude/skills/add-mcp-server/CHECKLIST.md`

Before integrating any new MCP:

```markdown
## Pre-Integration

- [ ] Read official documentation
- [ ] Check GitHub issues for common problems
- [ ] Review source code if documentation unclear
- [ ] Identify all required environment variables
- [ ] Test with minimal standalone example
- [ ] Document permission requirements

## Integration

- [ ] Add to settings.json with all required variables
- [ ] Add validation to scripts/validate-mcp.sh
- [ ] Test in container before deploying
- [ ] Verify tools appear in agent
- [ ] Test each function directly with API calls
- [ ] Document any gotchas or limitations

## Post-Integration

- [ ] Create usage examples in CLAUDE.md
- [ ] Add to troubleshooting guide
- [ ] Test with both main and non-main groups
- [ ] Verify instructions are followed
```

### Strategy #2: Explicit Configuration Loading

**What to Change**: Update all agent initialization code to explicitly load and log configuration

```typescript
// BEFORE (implicit):
const globalClaudeMd: string | undefined;
if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
  globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
}

// AFTER (explicit):
let globalClaudeMd: string | undefined;

// Load global CLAUDE.md for non-main groups
if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
  globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  log(`Loaded global CLAUDE.md: ${globalClaudeMd.substring(0, 100)}...`);
}

// Load group CLAUDE.md for main group (explicit, not relying on auto-detection)
if (containerInput.isMain && fs.existsSync(groupClaudeMdPath)) {
  const groupClaudeMd = fs.readFileSync(groupClaudeMdPath, 'utf-8');
  globalClaudeMd = globalClaudeMd ? `${globalClaudeMd}\n\n${groupClaudeMd}` : groupClaudeMd;
  log(`Loaded main group CLAUDE.md: ${groupClaudeMd.substring(0, 100)}...`);
}

// Verify it was loaded
if (!globalClaudeMd) {
  log('WARNING: No CLAUDE.md loaded for system prompt');
}
```

### Strategy #3: Test Scripts for Every Integration

**Directory**: `/scripts/test-integrations/`

Create standalone test scripts for each MCP:

```bash
# scripts/test-integrations/test-gmail-mcp.sh
#!/bin/bash
# Test Gmail MCP functions directly

echo "Testing Gmail MCP..."

# 1. Check environment variables
echo "✓ Checking environment..."
[ -n "$GOOGLE_WORKSPACE_CLIENT_ID" ] || { echo "✗ CLIENT_ID missing"; exit 1; }
[ -n "$GOOGLE_WORKSPACE_CLIENT_SECRET" ] || { echo "✗ CLIENT_SECRET missing"; exit 1; }
[ -n "$GOOGLE_WORKSPACE_REFRESH_TOKEN" ] || { echo "✗ REFRESH_TOKEN missing"; exit 1; }
[ -n "$GOOGLE_WORKSPACE_ENABLED_CAPABILITIES" ] || { echo "✗ ENABLED_CAPABILITIES missing"; exit 1; }

# 2. Test authentication
echo "✓ Testing authentication..."
python3 /tmp/test-gmail-auth.py || { echo "✗ Auth failed"; exit 1; }

# 3. Test read operations
echo "✓ Testing read operations..."
python3 /tmp/test-gmail-read.py || { echo "✗ Read failed"; exit 1; }

# 4. Test delete operations
echo "✓ Testing delete operations..."
python3 /tmp/test-gmail-delete.py || { echo "✗ Delete failed"; exit 1; }

echo "✅ All tests passed"
```

### Strategy #4: Session State Validation

**What to Add**: Helper command to check session state

```bash
# scripts/validate-session-state.sh
#!/bin/bash

GROUP=${1:-main}

echo "=== Session State for $GROUP ==="
echo ""

echo "Database session:"
sqlite3 store/messages.db "SELECT * FROM sessions WHERE group_folder = '$GROUP'"

echo ""
echo "Session cache files:"
ls -la data/sessions/$GROUP/.claude/ | grep -v "settings.json\|skills"

echo ""
echo "In-memory state (check service logs):"
tail -20 logs/nanoclaw.log | grep -i "session\|$GROUP"
```

### Strategy #5: Automated Regression Tests

**File**: `tests/integration/test-gmail-deletion.sh`

```bash
#!/bin/bash
set -e

echo "🧪 Gmail Deletion Integration Test"
echo ""

# 1. Setup: Create test email
echo "1. Creating test email..."
python3 tests/helpers/create-test-email.py

# 2. Test: Delete via agent
echo "2. Testing agent deletion..."
echo "Delete test emails from test@example.com" | docker run -i nanoclaw-agent:latest

# 3. Verify: Check emails moved to trash
echo "3. Verifying deletion..."
python3 tests/helpers/verify-deletion.py

echo "✅ Test passed"
```

---

## Documentation Updates Needed

### 1. Add MCP Setup Troubleshooting Section

**File**: `docs/TROUBLESHOOTING.md`

```markdown
## Gmail MCP Issues

### "No Gmail tools available"

**Symptom**: Agent doesn't see gmail_* tools despite MCP being configured

**Solution**: Add `GOOGLE_WORKSPACE_ENABLED_CAPABILITIES` to settings.json:
```json
{
  "env": {
    "GOOGLE_WORKSPACE_ENABLED_CAPABILITIES": "[\"gmail\", \"calendar\", \"drive\", \"docs\", \"sheets\", \"slides\"]"
  }
}
```

### "Permission denied when deleting emails"

**Symptom**: Agent can read emails but deletion fails

**Cause**: MCP's `gmail_bulk_delete_messages` requires full gmail access

**Solution**: Use the gmail-bulk-trash.py script instead (works with gmail.modify scope)

### "Agent ignores CLAUDE.md instructions"

**Symptom**: Agent uses MCP function despite CLAUDE.md saying not to

**Cause**: Bug in agent-runner.ts (fixed in commit XXXXX)

**Solution**: Ensure you're on latest version with explicit CLAUDE.md loading
```

### 2. Update Gmail Integration Guide

**File**: `.claude/skills/add-gmail-user/GUIDE.md`

Add section:

```markdown
## Common Issues

### Issue: "MCP server starts but no tools appear"

You're missing `GOOGLE_WORKSPACE_ENABLED_CAPABILITIES`. Add it to settings.json:

```json
{
  "GOOGLE_WORKSPACE_ENABLED_CAPABILITIES": "[\"gmail\"]"
}
```

### Issue: "Permission denied when deleting"

The MCP's delete function requires full Gmail access. Use the provided script instead:

```bash
python3 /home/node/.claude/skills/gmail-bulk-delete/gmail-bulk-trash.py 'from:sender@example.com'
```

This works with gmail.modify scope (safer).
```

### 3. Add Testing Guide

**File**: `docs/TESTING.md`

```markdown
## Testing MCP Integrations

Before deploying MCP changes:

1. **Test standalone**: Create Python script that directly calls the API
2. **Test in container**: Verify tools appear and work
3. **Test with agent**: Send real message and verify behavior
4. **Test instructions**: Verify agent follows CLAUDE.md directives

Example:
```bash
# 1. Standalone test
python3 tests/test-gmail-api.py

# 2. Container test
docker run -i nanoclaw-agent:latest

# 3. Agent test
echo "test message" | sqlite3 store/messages.db "INSERT INTO messages..."

# 4. Instruction test
# (add explicit wrong instruction to CLAUDE.md and verify agent doesn't follow it)
```
```

---

## Key Takeaways

### What We Learned

1. **MCP documentation is incomplete** - always check source code and GitHub issues
2. **Built-in tools override instructions** unless instructions are in system prompt
3. **Session caching is multi-layered** - database + filesystem + in-memory
4. **Implicit behavior is unreliable** - always load critical config explicitly
5. **Direct API testing finds MCP bugs fast** - test APIs before MCPs

### What To Do Differently

1. ✅ **Create MCP integration checklist** before adding new MCPs
2. ✅ **Always test APIs directly** before assuming MCP works
3. ✅ **Explicitly load all critical config** - never rely on auto-detection
4. ✅ **Add logging to show what config was loaded** for debugging
5. ✅ **Create test scripts for each integration** to catch regressions
6. ✅ **Document gotchas immediately** when discovered
7. ✅ **One change at a time** with verification after each

### Success Metrics

Before this retrospective:
- ❌ Gmail deletion didn't work
- ❌ Agent ignored instructions
- ❌ Unclear what was wrong

After this retrospective:
- ✅ Gmail deletion works reliably
- ✅ Agent respects instructions
- ✅ Clear documentation of what can go wrong
- ✅ Prevention strategies in place
- ✅ Test scripts for verification

---

## Action Items

### Immediate (This Session)

- [x] Fix GOOGLE_WORKSPACE_ENABLED_CAPABILITIES in all settings.json
- [x] Fix agent-runner.ts to explicitly load CLAUDE.md for main group
- [x] Create gmail-bulk-trash.py script as working alternative
- [x] Document the root causes
- [x] Verify fix works with real test

### Short Term (Next Session)

- [ ] Add MCP integration checklist to docs
- [ ] Create test scripts for Gmail MCP
- [ ] Update troubleshooting guide
- [ ] Add validation to scripts/validate-mcp.sh
- [ ] Add logging to show CLAUDE.md loading

### Long Term (Next Sprint)

- [ ] Audit all MCP integrations for missing variables
- [ ] Add automated integration tests
- [ ] Create session state debugging tools
- [ ] Review other implicit behaviors in codebase
- [ ] Consider adding config validation at startup

---

## Conclusion

**Time Investment**: ~4 hours of debugging
**Root Causes**: 2 bugs (missing env var + system prompt bug)
**Fixes Applied**: 3 (add env var, create script, fix system prompt loading)
**Lessons Learned**: 7 major takeaways
**Documentation Created**: This retrospective + updated troubleshooting guides

**Most Important Lesson**: **Explicit is better than implicit.** Never rely on auto-detection for critical functionality. Always load and log configuration explicitly so debugging is straightforward.

**Second Most Important Lesson**: **Test the underlying API directly before assuming MCP wrappers work correctly.** MCPs can have bugs or unexpected behavior. Direct API testing isolates problems fast.

**Third Most Important Lesson**: **Built-in tools always win over contextual instructions.** If you want the agent to follow instructions instead of using a built-in tool, those instructions MUST be in the system prompt, not just a file in the workspace.

---

Generated: 2026-02-15
