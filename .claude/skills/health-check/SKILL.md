# Health Check

Run comprehensive diagnostics on NanoClaw groups and service.

## What This Does

The `/health-check` skill verifies:
- ✓ Database registration completeness
- ✓ Folder structure integrity
- ✓ Service status
- ✓ Container cleanup
- ✓ Recent activity
- ✓ Trigger configuration
- ✓ Error logs

Useful for debugging or verifying everything is working after making changes.

## When to Use

Run `/health-check`:
- After registering a new group
- When messages aren't being received
- After service restarts
- Periodic system verification
- Before making configuration changes
- When troubleshooting issues

## Implementation

When user runs `/health-check`, execute these checks:

### 1. Database Registration Check

Query all registered groups and verify folder structure:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, folder, requires_trigger
  FROM registered_groups
" > /tmp/groups.txt

# For each group, check:
while IFS='|' read -r jid name folder trigger; do
  # Check folder exists
  [ -d "/workspace/project/groups/$folder" ] || echo "⚠ Missing folder: $folder"

  # Check subdirectories
  for dir in logs uploads memory conversations; do
    [ -d "/workspace/project/groups/$folder/$dir" ] || echo "⚠ Missing $folder/$dir/"
  done

  # Check CLAUDE.md
  [ -f "/workspace/project/groups/$folder/CLAUDE.md" ] || echo "⚠ Missing $folder/CLAUDE.md"
done < /tmp/groups.txt
```

### 2. Service Status

```bash
# Check if service is running
if pgrep -f "node.*dist/index.js" > /dev/null; then
  echo "✓ Service running (PID: $(pgrep -f 'node.*dist/index.js'))"
else
  echo "✗ Service NOT running"
fi

# Check Telegram bot connection (from logs)
tail -20 /workspace/project/logs/nanoclaw.log | grep -q "Telegram bot connected" && \
  echo "✓ Telegram connected" || echo "⚠ Telegram not connected"
```

### 3. Container Health

```bash
# Check for orphan containers
ORPHANS=$(docker ps -a --filter "ancestor=nanoclaw-agent:latest" --format "{{.Names}}" 2>/dev/null | wc -l)
if [ "$ORPHANS" -eq 0 ]; then
  echo "✓ No orphan containers"
else
  echo "⚠ Found $ORPHANS orphan container(s)"
  docker ps -a --filter "ancestor=nanoclaw-agent:latest" --format "  {{.Names}} - {{.Status}}"
fi
```

### 4. Recent Activity

```bash
# Check message counts per group (last 24 hours)
sqlite3 /workspace/project/store/messages.db "
  SELECT
    rg.name,
    COUNT(m.id) as msg_count,
    MAX(m.timestamp) as last_msg
  FROM registered_groups rg
  LEFT JOIN messages m ON m.chat_jid = rg.jid
    AND datetime(m.timestamp) > datetime('now', '-1 day')
  GROUP BY rg.jid, rg.name
  ORDER BY msg_count DESC
"
```

### 5. Trigger Configuration

```bash
# Verify trigger patterns are set correctly
sqlite3 /workspace/project/store/messages.db "
  SELECT name, trigger_pattern, requires_trigger
  FROM registered_groups
" | while IFS='|' read -r name pattern req; do
  echo "$name:"
  echo "  Pattern: $pattern"
  [ "$req" = "0" ] && echo "  Mode: No trigger needed" || echo "  Mode: Requires trigger"
done
```

### 6. Recent Errors

```bash
# Check last 50 log lines for errors
ERROR_COUNT=$(tail -50 /workspace/project/logs/nanoclaw.log | grep -c "ERROR")
if [ "$ERROR_COUNT" -eq 0 ]; then
  echo "✓ No recent errors"
else
  echo "⚠ Found $ERROR_COUNT error(s) in last 50 lines:"
  tail -50 /workspace/project/logs/nanoclaw.log | grep "ERROR" | tail -3
fi
```

### 7. Format Results

Present results in a clean, readable format:

```
*NanoClaw Health Check*

*Groups:*
✓ Emil (main) - 47 messages today
✓ A3 (a3) - 13 messages today
✓ Mark (mark) - No messages yet

*Service:*
✓ Running (PID: 70323)
✓ Telegram connected
✓ No orphan containers

*Issues:*
None found

Run this anytime to verify system health.
```

## Auto-Fix Common Issues

If you detect issues, offer to fix them:

**Missing conversations/ directory:**
```bash
mkdir -p /workspace/project/groups/{folder}/conversations
```

**Orphan containers:**
```bash
docker rm -f $(docker ps -aq --filter "ancestor=nanoclaw-agent:latest")
```

**Service not running:**
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Notes

- Run from main group only (needs project-level access)
- Safe to run anytime (read-only checks)
- Auto-fix requires user confirmation
- Results cached for 30 seconds (avoid spam)

## Usage Examples

**Simple check:**
```
/health-check
→ Runs all checks, reports status
```

**With auto-fix:**
```
/health-check --fix
→ Automatically fixes common issues
```

**Specific group:**
```
/health-check mark
→ Checks only Mark's group
```
