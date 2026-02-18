# Register New User

Register a new Telegram or WhatsApp user's DM as a NanoClaw group. Use when adding a new person who should be able to chat with the bot.

Triggers: "register user", "add user", "new user", "set up DM for", "register chat"

## Step-by-Step

### 1. Get the Chat ID

- **Telegram**: User sends `/chatid` to the bot. Copy the `tg:XXXXXXX` value.
- **WhatsApp**: User sends a message, then query DB:
  ```bash
  sqlite3 /workspace/project/store/messages.db "SELECT jid, name FROM chats WHERE name LIKE '%USERNAME%' AND jid LIKE '%@s.whatsapp.net'"
  ```

### 2. Register via IPC

Write an IPC task file with these **exact** fields. Every field is required.

```json
{
  "type": "register_group",
  "jid": "tg:XXXXXXXXX",
  "name": "Username - Personal",
  "folder": "username-tg",
  "trigger": "@Frankie",
  "requiresTrigger": false
}
```

**CRITICAL: `requiresTrigger` must be boolean `false`, NOT the string `"false"`.**

For DMs/personal chats, ALWAYS set `requiresTrigger: false` so every message gets a response. Only use `requiresTrigger: true` for group chats where the bot should only respond when @mentioned.

### 3. Verify Registration

After writing the IPC task, verify it took effect:

```bash
sqlite3 /workspace/project/store/messages.db "SELECT jid, name, folder, requires_trigger FROM registered_groups WHERE jid='THE_JID'"
```

Check that `requires_trigger` is `0` (not `1`). If it's `1`, the registration was wrong — fix it:

```bash
sqlite3 /workspace/project/store/messages.db "UPDATE registered_groups SET requires_trigger=0 WHERE jid='THE_JID'"
```

### 4. Create Group Folder and CLAUDE.md

The IPC handler creates the folder, but verify it exists:

```bash
mkdir -p /workspace/project/groups/USERNAME-FOLDER/logs
```

**REQUIRED: Create a CLAUDE.md for the group.** Without this, the agent has no instructions and will make avoidable mistakes (wrong tools, no formatting, silent failures).

Write `groups/USERNAME-FOLDER/CLAUDE.md` with at minimum:

```markdown
# Frankie

Personal assistant for USERNAME.

## Gmail

**DO NOT use `gmail_bulk_delete_messages`** — it fails silently (wrong scope).

**To delete/trash emails:** Use the Python script:
\```
python3 /home/node/.claude/skills/gmail-bulk-delete/gmail-bulk-trash.py 'search query'
\```

## Important

*Always respond to the user after completing an action.* Never end a turn silently.
```

Add any user-specific context (name, preferences, timezone if different from Pacific).

### 5. Send Welcome Message

Send a message to the new user confirming setup:

```json
{
  "type": "send_message",
  "jid": "tg:XXXXXXXXX",
  "message": "Hi! Your chat is now set up. You can message me anytime — no need to use @Frankie in DMs."
}
```

## Common Mistakes

| Mistake | Consequence | Prevention |
|---------|-------------|------------|
| `requiresTrigger` omitted | Defaults to `true` — user's messages ignored | Always set explicitly to `false` for DMs |
| `"requiresTrigger": "false"` (string) | Truthy string → treated as `true` | Use boolean `false`, not string |
| No group folder created | Container fails to start | Always verify folder exists |
| No CLAUDE.md created | Agent has no instructions, uses wrong tools, fails silently | Always create CLAUDE.md with Gmail warnings |
| Forgot to verify DB | Bad registration goes unnoticed | Always query DB after registering |

## Folder Naming Convention

- Telegram DM: `username-tg` (e.g., `franklin-tg`, `mark-tg`)
- WhatsApp DM: `username-wa` (e.g., `jackie-wa`)
- Group chat: `descriptive-name` (e.g., `family-chat`, `work-team`)

## Adding Gmail Access

After registering, if the user needs Gmail access, follow the `/add-gmail-user` skill.
