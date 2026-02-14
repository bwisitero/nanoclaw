# Compact Conversation

Summarize recent conversation and save to searchable memory archive.

## What This Does

The `/compact` command:
1. Reads recent conversation messages from SQLite
2. Generates a summary using Claude
3. Saves to `groups/{folder}/conversations/YYYY-MM-DD-summary.md`
4. Agent can later search these summaries with `search_memory` tool

This gives you OpenClaw-style conversation memory without automatic daily summarization.

## When to Use

Run `/compact`:
- End of day to archive today's conversation
- After important discussions you want to recall later
- Before starting a new topic to clear context
- Anytime you want the agent to remember the current conversation

## Implementation

When user runs `/compact`, follow these steps:

### 1. Determine the group and date range

Ask the user:
> How many days back should I summarize?
>
> Options:
> 1. Today only (default)
> 2. Last 3 days
> 3. Last 7 days
> 4. Custom date range

Default to "today only" if they just say "compact" without specifics.

### 2. Query SQLite for messages

Read the messages from the database:

```bash
# Get today's messages (default)
sqlite3 /workspace/project/store/messages.db "
  SELECT sender_name, content, timestamp
  FROM messages
  WHERE chat_jid = '$(cat /workspace/ipc/input/chat_jid.txt)'
    AND date(timestamp) = date('now')
  ORDER BY timestamp ASC
" > /tmp/messages.txt
```

For multi-day summaries, adjust the WHERE clause:
```sql
WHERE chat_jid = '...'
  AND date(timestamp) >= date('now', '-3 days')
```

### 3. Format the messages

Create a markdown file with the raw conversation:

```bash
cat > /tmp/conversation.md << 'EOF'
# Conversation Summary Request

Date: $(date +%Y-%m-%d)
Group: $(cat /workspace/ipc/input/group_folder.txt)

## Raw Conversation

$(cat /tmp/messages.txt)

## Instructions

Please create a concise summary of this conversation covering:
- Main topics discussed
- Decisions made
- Action items or tasks mentioned
- Important facts or preferences shared
- Questions that remain unresolved

Keep it under 500 words. Use markdown formatting.
EOF
```

### 4. Generate summary using Claude

You (the assistant handling /compact) should:
- Read the messages from `/tmp/conversation.md`
- Generate a clear, structured summary
- Focus on key information that would be useful to recall later

### 5. Save the summary

Write the summary to the conversations directory:

```bash
# Create conversations directory if needed
mkdir -p /workspace/group/conversations

# Save summary with today's date
DATE=$(date +%Y-%m-%d)
cat > /workspace/group/conversations/${DATE}-summary.md << 'EOF'
# Conversation Summary - ${DATE}

## Topics Discussed
[Your summary content here]

## Decisions Made
[...]

## Action Items
[...]

## Important Facts
[...]

## Open Questions
[...]
EOF
```

### 6. Confirm to user

Reply to the user:
> ✅ Conversation summarized and saved to `conversations/YYYY-MM-DD-summary.md`
>
> I can now search this conversation using the `search_memory` tool.
>
> [Show a brief 2-3 sentence preview of the summary]

## Usage Examples

**Simple compact:**
```
User: /compact
Assistant: [Summarizes today's conversation]
```

**Custom date range:**
```
User: /compact last week
Assistant: How many days back should I summarize?
User: 7 days
Assistant: [Summarizes last 7 days]
```

**With specific date:**
```
User: /compact 2026-02-10
Assistant: [Summarizes that specific date]
```

## Notes

- Summaries are per-group (main, family-chat, work-team all separate)
- If a date already has a summary, offer to overwrite or append
- Keep summaries concise - they're for quick recall, not full transcripts
- The raw SQLite database always has the full conversation history

## Related Tools

After running `/compact`, the agent can use:
- `search_memory(query)` - Search past summaries
- `remember(fact)` - Save specific facts to memory/facts.md

## Troubleshooting

**"No messages found"** - Check the date range or verify messages exist in SQLite:
```bash
sqlite3 /workspace/project/store/messages.db "SELECT COUNT(*) FROM messages WHERE chat_jid = '...'"
```

**Summary too long** - Adjust the prompt to be more concise or break into multiple summaries by topic.

**Want automatic daily summaries?** - Use the `schedule_task` tool to run this as a cron job:
```
schedule_task(
  prompt: "Run /compact to summarize today's conversation",
  schedule_type: "cron",
  schedule_value: "0 2 * * *"  // 2am daily
)
```
