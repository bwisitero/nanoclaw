#!/usr/bin/env python3
"""
Gmail Bulk Trash Tool
Moves emails to TRASH using batchModify (not permanent delete)
Usage: gmail-bulk-trash.py <from_email_or_query>
"""

import os
import sys
import time

try:
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    from google.auth.transport.requests import Request
except ImportError:
    print("ERROR: Missing google libraries")
    print("Install with: pip3 install google-auth google-auth-oauthlib google-api-python-client")
    sys.exit(1)

if len(sys.argv) != 2:
    print("Usage: gmail-bulk-trash.py <query>")
    print("Example: gmail-bulk-trash.py 'from:deals@slickdeals.net'")
    sys.exit(1)

query = sys.argv[1]

# Get credentials from environment
client_id = os.environ.get('GOOGLE_WORKSPACE_CLIENT_ID')
client_secret = os.environ.get('GOOGLE_WORKSPACE_CLIENT_SECRET')
refresh_token = os.environ.get('GOOGLE_WORKSPACE_REFRESH_TOKEN')

if not all([client_id, client_secret, refresh_token]):
    print("ERROR: Missing required environment variables:")
    print("  GOOGLE_WORKSPACE_CLIENT_ID")
    print("  GOOGLE_WORKSPACE_CLIENT_SECRET")
    print("  GOOGLE_WORKSPACE_REFRESH_TOKEN")
    sys.exit(1)

# Create credentials
credentials = Credentials(
    None,
    refresh_token=refresh_token,
    token_uri="https://oauth2.googleapis.com/token",
    client_id=client_id,
    client_secret=client_secret,
    scopes=['https://www.googleapis.com/auth/gmail.modify']
)

# Authenticate
try:
    credentials.refresh(Request())
    service = build('gmail', 'v1', credentials=credentials)
except Exception as e:
    print(f"ERROR: Authentication failed: {e}")
    sys.exit(1)

# Search for emails
try:
    all_messages = []
    page_token = None

    while True:
        if page_token:
            results = service.users().messages().list(
                userId='me',
                q=query,
                pageToken=page_token,
                maxResults=500
            ).execute()
        else:
            results = service.users().messages().list(
                userId='me',
                q=query,
                maxResults=500
            ).execute()

        messages = results.get('messages', [])
        all_messages.extend(messages)

        page_token = results.get('nextPageToken')
        if not page_token:
            break

    if len(all_messages) == 0:
        print("No emails found matching query")
        sys.exit(0)

    print(f"Found {len(all_messages)} emails")

except Exception as e:
    print(f"ERROR: Search failed: {e}")
    sys.exit(1)

# Batch move to TRASH
try:
    batch_size = 1000
    total_trashed = 0

    for i in range(0, len(all_messages), batch_size):
        batch = all_messages[i:i+batch_size]
        message_ids = [msg['id'] for msg in batch]

        service.users().messages().batchModify(
            userId='me',
            body={
                'ids': message_ids,
                'addLabelIds': ['TRASH']
            }
        ).execute()

        total_trashed += len(message_ids)
        print(f"Trashed batch {i//batch_size + 1}: {len(message_ids)} emails (total: {total_trashed}/{len(all_messages)})")

        if i + batch_size < len(all_messages):
            time.sleep(0.5)

    print(f"SUCCESS: Moved {total_trashed} emails to TRASH")

except Exception as e:
    print(f"ERROR: Batch trash failed: {e}")
    sys.exit(1)
