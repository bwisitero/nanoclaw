#!/bin/bash
#
# NanoClaw Backup Script
# Backs up all data (messages, files, auth, config) but NOT code
#
# Usage:
#   ./backup.sh                    # Backup to ~/nanoclaw-backups/
#   ./backup.sh /path/to/backup    # Backup to custom location

set -e

# Backup destination
BACKUP_DIR="${1:-$HOME/nanoclaw-backups}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/nanoclaw-$TIMESTAMP.tar.gz"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

echo "NanoClaw Backup"
echo "==============="
echo "Timestamp: $TIMESTAMP"
echo "Destination: $BACKUP_FILE"
echo ""

# What we're backing up
echo "Backing up:"
echo "  - SQLite database (messages, groups, tasks)"
echo "  - WhatsApp/Telegram auth sessions"
echo "  - Uploaded files from all groups"
echo "  - Configuration (.env, transcription config)"
echo "  - Service config (launchd plist)"
echo ""

# Create the backup
tar -czf "$BACKUP_FILE" \
  --exclude='groups/*/logs/*' \
  --exclude='groups/*/.DS_Store' \
  store/ \
  groups/*/uploads/ \
  groups/*/CLAUDE.md \
  groups/*/sessions/ \
  data/ \
  .env \
  .transcription.config.json \
  ~/Library/LaunchAgents/com.nanoclaw.plist \
  2>/dev/null || true

# Get backup size
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | awk '{print $1}')

echo "✅ Backup complete!"
echo ""
echo "File: $BACKUP_FILE"
echo "Size: $BACKUP_SIZE"
echo ""

# Cleanup old backups (keep last 7 days)
echo "Cleaning up old backups (keeping last 7 days)..."
find "$BACKUP_DIR" -name "nanoclaw-*.tar.gz" -mtime +7 -delete 2>/dev/null || true

echo "Done!"
