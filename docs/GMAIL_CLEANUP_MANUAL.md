# Gmail Manual Cleanup Guide

Since the Gmail API deletion permissions are experiencing issues, this guide provides search queries for manual bulk deletion via Gmail's web interface.

## Method

1. Open Gmail in browser: https://mail.google.com
2. Copy a search query from below into the Gmail search box
3. Click "Select all" checkbox above message list
4. If there are more than 50 results, click "Select all conversations that match this search"
5. Click Delete button (trash icon)
6. Repeat for other categories

## Search Queries

### Newsletter & Retail Promotions

```
from:(mkt@manning.com OR noreply@slickdeals.net OR newsletters@goodreads.com OR bounce@marketing.udemy.com OR no-reply@news.linkedin.com OR noreply@medium.com OR notification@facebookmail.com)
```

**Expected Results:** Marketing emails, newsletters, promotional content from retailers and platforms.

### Real Estate Marketing (with large attachments)

```
from:(rizza.quimora@gmail.com OR jasonaguinaldo@realtor.com OR realtor@examples.com) has:attachment larger:1M
```

**Expected Results:** Property listing emails with PDF/image attachments over 1MB.

### Social Media Notifications

```
from:(notification@facebookmail.com OR no-reply@twitter.com OR notifications@linkedin.com OR noreply@instagram.com)
```

**Expected Results:** Facebook, Twitter, LinkedIn, Instagram notifications (likes, comments, follows, etc).

### Automated Service Emails

```
from:(no-reply@ OR noreply@ OR do-not-reply@) older_than:6m
```

**Expected Results:** Automated emails from various services older than 6 months.

### GitHub Notifications (if not needed)

```
from:notifications@github.com
```

**Expected Results:** GitHub issue notifications, PR updates, repository activity.

## Tips

- **Dry Run First**: Remove everything after the search query except `from:(...)` to see what you'll delete before committing
- **Incremental**: Do one category at a time to avoid accidentally deleting important emails
- **Archive Instead**: If unsure, use Archive (E key) instead of Delete to keep emails but remove from inbox
- **Labels**: Consider adding labels to patterns you want to keep before bulk deleting
- **Undo**: Gmail shows "Undo" notification for ~5 seconds after deletion - act quickly if needed

## Safety Checks

Before deleting, verify none of these appear in results:
- Bank statements or financial documents you need
- Receipts for recent purchases
- Booking confirmations for upcoming travel
- Shipping notifications for pending deliveries
- Password reset emails from the last 90 days

## Why Manual Method?

The Gmail API deletion is encountering persistent permission errors despite:
- Full `gmail.modify` OAuth scope granted
- Valid refresh token with all permissions
- Multiple token regenerations
- API enabled in GCP console

The manual method using Gmail's web interface is guaranteed to work and gives you visual confirmation of what's being deleted.

## Future: API Investigation

To debug the API issue separately (optional):
1. Test with simpler operations (search only, mark as read)
2. Check GCP project API enablement status
3. Verify OAuth consent screen configuration
4. Test with minimal scopes first, then add incrementally
5. Check MCP server logs for detailed error messages

---

Generated: 2026-02-15
