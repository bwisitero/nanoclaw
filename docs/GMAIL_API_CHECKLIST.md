# Gmail API Configuration Checklist

## What Was Missing

**CRITICAL:** The `GOOGLE_WORKSPACE_ENABLED_CAPABILITIES` environment variable was not configured in your settings.json files. I've now added it to:
- ✅ `data/sessions/main/.claude/settings.json`
- ✅ `data/sessions/a3/.claude/settings.json`
- ✅ `data/sessions/mark/.claude/settings.json`
- ✅ `src/container-runner.ts` (template for new groups)

## Required Google Cloud Console Configuration

You need to verify all these APIs are explicitly **enabled** in your Google Cloud Console project:

### Step 1: Check API Enablement

Go to: https://console.cloud.google.com/apis/dashboard?project=frankie-assistant-487519

Verify these APIs show as **ENABLED**:

1. ✅ **Gmail API** - `gmail.googleapis.com`
2. ✅ **Google Calendar API** - `calendar-json.googleapis.com`
3. ✅ **Google Drive API** - `drive.googleapis.com`
4. ✅ **Google Docs API** - `docs.googleapis.com`
5. ✅ **Google Sheets API** - `sheets.googleapis.com`
6. ✅ **Google Slides API** - `slides.googleapis.com`

**If any are missing:**
1. Click "ENABLE APIS AND SERVICES"
2. Search for the API name
3. Click "Enable"

### Step 2: Verify OAuth Scopes

Your refresh token was generated with these scopes (from `/tmp/get_google_refresh_token.py`):

```
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/gmail.modify  ← Critical for deletion
https://www.googleapis.com/auth/calendar
```

**Verify granted permissions:**
1. Go to: https://myaccount.google.com/permissions
2. Find "Frankie Assistant"
3. Click to see permissions
4. Confirm all 6 services are listed

**If scopes are missing:** You'll need to regenerate your refresh token:
```bash
source /tmp/oauth-env/bin/activate
python3 /tmp/get_google_refresh_token.py \
  --client-id "YOUR_CLIENT_ID" \
  --client-secret "YOUR_CLIENT_SECRET"
```

Then update `data/sessions/main/.claude/settings.json` with the new token.

### Step 3: Configuration Summary

Your current configuration:

**main/.claude/settings.json:**
```json
{
  "env": {
    "GOOGLE_WORKSPACE_CLIENT_ID": "${GOOGLE_WORKSPACE_CLIENT_ID}",
    "GOOGLE_WORKSPACE_CLIENT_SECRET": "${GOOGLE_WORKSPACE_CLIENT_SECRET}",
    "GOOGLE_WORKSPACE_REFRESH_TOKEN": "1//067zVy_uFf5p...",
    "GOOGLE_WORKSPACE_ENABLED_CAPABILITIES": "[\"gmail\", \"calendar\", \"drive\", \"docs\", \"sheets\", \"slides\"]"
  }
}
```

**Environment variables** (from .env):
- `GOOGLE_WORKSPACE_CLIENT_ID` - Your OAuth client ID
- `GOOGLE_WORKSPACE_CLIENT_SECRET` - Your OAuth client secret

## Testing

After verifying the above, rebuild and restart:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Then test with a simple read operation first:

**In Telegram/WhatsApp:**
```
List my Gmail labels
```

If that works, try a search:
```
Search my email for: from:noreply@ newer_than:1d
```

Then finally test deletion:
```
Delete all emails matching: from:noreply@slickdeals.net older_than:30d
```

## Common Issues

### "Tool not found" or Gmail tools unavailable
- Check `GOOGLE_WORKSPACE_ENABLED_CAPABILITIES` includes `"gmail"`
- Verify Gmail API is enabled in GCP Console

### "Insufficient permissions" or 403 errors
- Verify `gmail.modify` scope was granted during OAuth
- Check https://myaccount.google.com/permissions
- May need to regenerate refresh token with correct scopes

### "API not enabled"
- Go to GCP Console → APIs & Services → Library
- Search for "Gmail API" and enable it
- Wait 1-2 minutes for enablement to propagate

### "Invalid credentials"
- Verify CLIENT_ID and CLIENT_SECRET in .env match GCP Console
- Regenerate refresh token if they were changed

## Next Steps

1. Open GCP Console and verify all 6 APIs are enabled
2. Check granted permissions at myaccount.google.com
3. Rebuild and restart NanoClaw
4. Test with "List my Gmail labels" first
5. Try searching before deleting

---

Generated: 2026-02-15
