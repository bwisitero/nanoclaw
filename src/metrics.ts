/**
 * NanoClaw Analytics & Metrics
 *
 * Usage:
 *   npm run metrics               # Show dashboard
 *   npm run metrics user <sender> # User-specific stats
 *   npm run metrics group <jid>   # Group-specific stats
 */

import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'store', 'messages.db'));

interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
}

interface GroupRow {
  jid: string;
  name: string;
  folder: string;
  added_at: string;
  requires_trigger: number;
}

interface UserStats {
  sender: string;
  sender_name: string;
  total_messages: number;
  text_messages: number;
  voice_messages: number;
  photos: number;
  documents: number;
  first_message: string;
  last_message: string;
}

interface GroupStats {
  jid: string;
  name: string;
  total_messages: number;
  unique_users: number;
  bot_responses: number;
  first_message: string;
  last_message: string;
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function printDashboard(): void {
  console.log('\n📊 NanoClaw Analytics Dashboard\n');
  console.log('═'.repeat(60));

  // Overall stats
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  const totalGroups = db.prepare('SELECT COUNT(*) as count FROM registered_groups').get() as { count: number };
  const uniqueUsers = db.prepare('SELECT COUNT(DISTINCT sender) as count FROM messages WHERE is_from_me = 0').get() as { count: number };
  const botMessages = db.prepare('SELECT COUNT(*) as count FROM messages WHERE is_from_me = 1').get() as { count: number };

  console.log('\n📈 Overall Statistics');
  console.log('─'.repeat(60));
  console.log(`Total Messages:     ${totalMessages.count.toLocaleString()}`);
  console.log(`Bot Responses:      ${botMessages.count.toLocaleString()}`);
  console.log(`Registered Groups:  ${totalGroups.count}`);
  console.log(`Unique Users:       ${uniqueUsers.count}`);

  // Group activity
  console.log('\n👥 Group Activity (Last 7 Days)');
  console.log('─'.repeat(60));

  const groupActivity = db.prepare(`
    SELECT
      rg.name,
      rg.jid,
      COUNT(*) as message_count,
      COUNT(DISTINCT m.sender) as unique_users,
      MAX(m.timestamp) as last_activity
    FROM messages m
    JOIN registered_groups rg ON m.chat_jid = rg.jid
    WHERE m.timestamp >= datetime('now', '-7 days')
    GROUP BY m.chat_jid
    ORDER BY message_count DESC
  `).all() as Array<{ name: string; jid: string; message_count: number; unique_users: number; last_activity: string }>;

  if (groupActivity.length > 0) {
    groupActivity.forEach((group, idx) => {
      console.log(`${idx + 1}. ${group.name}`);
      console.log(`   Messages: ${group.message_count} | Users: ${group.unique_users} | Last: ${formatDate(group.last_activity)}`);
    });
  } else {
    console.log('   No activity in the last 7 days');
  }

  // Top users
  console.log('\n👤 Most Active Users (Last 30 Days)');
  console.log('─'.repeat(60));

  const topUsers = db.prepare(`
    SELECT
      sender_name,
      COUNT(*) as message_count,
      COUNT(CASE WHEN content LIKE '[Voice:%' THEN 1 END) as voice_count,
      COUNT(CASE WHEN content LIKE '[Photo%' THEN 1 END) as photo_count,
      COUNT(CASE WHEN content LIKE '[Document%' THEN 1 END) as doc_count,
      MAX(timestamp) as last_seen
    FROM messages
    WHERE is_from_me = 0
      AND timestamp >= datetime('now', '-30 days')
      AND sender_name != 'Unknown'
    GROUP BY sender
    ORDER BY message_count DESC
    LIMIT 10
  `).all() as Array<{
    sender_name: string;
    message_count: number;
    voice_count: number;
    photo_count: number;
    doc_count: number;
    last_seen: string;
  }>;

  if (topUsers.length > 0) {
    topUsers.forEach((user, idx) => {
      const extras: string[] = [];
      if (user.voice_count > 0) extras.push(`${user.voice_count} voice`);
      if (user.photo_count > 0) extras.push(`${user.photo_count} photos`);
      if (user.doc_count > 0) extras.push(`${user.doc_count} docs`);
      const extraStr = extras.length > 0 ? ` (${extras.join(', ')})` : '';

      console.log(`${idx + 1}. ${user.sender_name}: ${user.message_count} messages${extraStr}`);
      console.log(`   Last seen: ${formatDate(user.last_seen)}`);
    });
  } else {
    console.log('   No user activity in the last 30 days');
  }

  // Message type breakdown
  console.log('\n📝 Message Types (All Time)');
  console.log('─'.repeat(60));

  const messageTypes = db.prepare(`
    SELECT
      CASE
        WHEN content LIKE '[Voice:%' THEN 'Voice Messages'
        WHEN content LIKE '[Photo%' THEN 'Photos'
        WHEN content LIKE '[Video%' THEN 'Videos'
        WHEN content LIKE '[Document%' THEN 'Documents'
        WHEN content LIKE '[Audio%' THEN 'Audio Files'
        WHEN content LIKE '[Sticker%' THEN 'Stickers'
        ELSE 'Text Messages'
      END as type,
      COUNT(*) as count
    FROM messages
    WHERE is_from_me = 0
    GROUP BY type
    ORDER BY count DESC
  `).all() as Array<{ type: string; count: number }>;

  messageTypes.forEach(type => {
    const percentage = ((type.count / totalMessages.count) * 100).toFixed(1);
    console.log(`${type.type.padEnd(20)} ${type.count.toString().padStart(8)} (${percentage}%)`);
  });

  // Peak activity times
  console.log('\n⏰ Peak Activity Hours (Last 30 Days)');
  console.log('─'.repeat(60));

  const peakHours = db.prepare(`
    SELECT
      CAST(strftime('%H', timestamp) AS INTEGER) as hour,
      COUNT(*) as message_count
    FROM messages
    WHERE timestamp >= datetime('now', '-30 days')
      AND is_from_me = 0
    GROUP BY hour
    ORDER BY message_count DESC
    LIMIT 5
  `).all() as Array<{ hour: number; message_count: number }>;

  peakHours.forEach((h, idx) => {
    const hourStr = `${h.hour.toString().padStart(2, '0')}:00-${(h.hour + 1).toString().padStart(2, '0')}:00`;
    console.log(`${idx + 1}. ${hourStr}: ${h.message_count} messages`);
  });

  // Cost estimation (AWS Bedrock)
  console.log('\n💰 Estimated Costs (Last 30 Days)');
  console.log('─'.repeat(60));

  const recentBotMessages = db.prepare(`
    SELECT COUNT(*) as count
    FROM messages
    WHERE is_from_me = 1
      AND timestamp >= datetime('now', '-30 days')
  `).get() as { count: number };

  // Rough estimates:
  // - AWS Bedrock Sonnet: ~$3 per million input tokens, ~$15 per million output tokens
  // - Average: ~1000 input tokens, ~500 output tokens per message
  const avgInputTokens = 1000;
  const avgOutputTokens = 500;
  const inputCost = (recentBotMessages.count * avgInputTokens * 3) / 1000000;
  const outputCost = (recentBotMessages.count * avgOutputTokens * 15) / 1000000;
  const totalCost = inputCost + outputCost;

  console.log(`Bot Responses:        ${recentBotMessages.count}`);
  console.log(`Estimated Input:      ${(recentBotMessages.count * avgInputTokens).toLocaleString()} tokens (~$${inputCost.toFixed(2)})`);
  console.log(`Estimated Output:     ${(recentBotMessages.count * avgOutputTokens).toLocaleString()} tokens (~$${outputCost.toFixed(2)})`);
  console.log(`Total Estimated Cost: $${totalCost.toFixed(2)}`);
  console.log(`\n   Note: Actual costs may vary based on message complexity`);

  console.log('\n' + '═'.repeat(60) + '\n');
}

function printUserStats(sender: string): void {
  const user = db.prepare(`
    SELECT
      sender,
      sender_name,
      COUNT(*) as total_messages,
      COUNT(CASE WHEN content NOT LIKE '[%' THEN 1 END) as text_messages,
      COUNT(CASE WHEN content LIKE '[Voice:%' THEN 1 END) as voice_messages,
      COUNT(CASE WHEN content LIKE '[Photo%' THEN 1 END) as photos,
      COUNT(CASE WHEN content LIKE '[Document%' THEN 1 END) as documents,
      MIN(timestamp) as first_message,
      MAX(timestamp) as last_message
    FROM messages
    WHERE (sender = ? OR sender_name = ?)
      AND is_from_me = 0
  `).get(sender, sender) as UserStats | undefined;

  if (!user || user.total_messages === 0) {
    console.log(`\n❌ No messages found for user: ${sender}\n`);
    return;
  }

  console.log(`\n👤 User Statistics: ${user.sender_name}\n`);
  console.log('═'.repeat(60));
  console.log(`Total Messages:      ${user.total_messages}`);
  console.log(`Text Messages:       ${user.text_messages}`);
  console.log(`Voice Messages:      ${user.voice_messages}`);
  console.log(`Photos:              ${user.photos}`);
  console.log(`Documents:           ${user.documents}`);
  console.log(`First Message:       ${formatDate(user.first_message)}`);
  console.log(`Last Message:        ${formatDate(user.last_message)}`);

  // Groups this user is in
  console.log(`\n📱 Active in Groups:`);
  console.log('─'.repeat(60));

  const groups = db.prepare(`
    SELECT
      rg.name,
      COUNT(*) as message_count,
      MAX(m.timestamp) as last_message
    FROM messages m
    JOIN registered_groups rg ON m.chat_jid = rg.jid
    WHERE (m.sender = ? OR m.sender_name = ?)
      AND m.is_from_me = 0
    GROUP BY m.chat_jid
    ORDER BY message_count DESC
  `).all(sender, sender) as Array<{ name: string; message_count: number; last_message: string }>;

  groups.forEach(group => {
    console.log(`${group.name}: ${group.message_count} messages (last: ${formatDate(group.last_message)})`);
  });

  console.log('\n' + '═'.repeat(60) + '\n');
}

function printGroupStats(jid: string): void {
  const group = db.prepare(`
    SELECT
      rg.name,
      rg.jid,
      COUNT(m.id) as total_messages,
      COUNT(DISTINCT m.sender) as unique_users,
      COUNT(CASE WHEN m.is_from_me = 1 THEN 1 END) as bot_responses,
      MIN(m.timestamp) as first_message,
      MAX(m.timestamp) as last_message
    FROM registered_groups rg
    LEFT JOIN messages m ON m.chat_jid = rg.jid
    WHERE rg.jid = ? OR rg.name = ?
    GROUP BY rg.jid
  `).get(jid, jid) as GroupStats | undefined;

  if (!group) {
    console.log(`\n❌ Group not found: ${jid}\n`);
    return;
  }

  console.log(`\n👥 Group Statistics: ${group.name}\n`);
  console.log('═'.repeat(60));
  console.log(`JID:                 ${group.jid}`);
  console.log(`Total Messages:      ${group.total_messages}`);
  console.log(`Unique Users:        ${group.unique_users}`);
  console.log(`Bot Responses:       ${group.bot_responses}`);
  if (group.first_message) {
    console.log(`First Message:       ${formatDate(group.first_message)}`);
    console.log(`Last Message:        ${formatDate(group.last_message)}`);
  }

  // Top users in this group
  console.log(`\n👤 Most Active Users:`);
  console.log('─'.repeat(60));

  const users = db.prepare(`
    SELECT
      sender_name,
      COUNT(*) as message_count,
      MAX(timestamp) as last_message
    FROM messages
    WHERE chat_jid = ?
      AND is_from_me = 0
      AND sender_name != 'Unknown'
    GROUP BY sender
    ORDER BY message_count DESC
    LIMIT 10
  `).all(group.jid) as Array<{ sender_name: string; message_count: number; last_message: string }>;

  if (users.length > 0) {
    users.forEach((user, idx) => {
      console.log(`${idx + 1}. ${user.sender_name}: ${user.message_count} messages (last: ${formatDate(user.last_message)})`);
    });
  } else {
    console.log('   No messages yet');
  }

  // Activity over time
  console.log(`\n📊 Activity Last 7 Days:`);
  console.log('─'.repeat(60));

  const dailyActivity = db.prepare(`
    SELECT
      date(timestamp) as day,
      COUNT(*) as message_count
    FROM messages
    WHERE chat_jid = ?
      AND timestamp >= datetime('now', '-7 days')
    GROUP BY day
    ORDER BY day DESC
  `).all(group.jid) as Array<{ day: string; message_count: number }>;

  if (dailyActivity.length > 0) {
    dailyActivity.forEach(day => {
      const bar = '█'.repeat(Math.min(day.message_count, 50));
      console.log(`${day.day}: ${bar} ${day.message_count}`);
    });
  } else {
    console.log('   No activity in the last 7 days');
  }

  console.log('\n' + '═'.repeat(60) + '\n');
}

// CLI entry point
const command = process.argv[2];
const arg = process.argv[3];

if (command === 'user' && arg) {
  printUserStats(arg);
} else if (command === 'group' && arg) {
  printGroupStats(arg);
} else {
  printDashboard();
}

db.close();
