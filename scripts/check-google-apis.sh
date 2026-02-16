#!/bin/bash
# Check if required Google Cloud APIs are enabled

set -e

echo "Google Cloud API Status Checker"
echo "================================"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "⚠️  gcloud CLI not installed"
    echo ""
    echo "To install:"
    echo "  brew install google-cloud-sdk"
    echo ""
    echo "Or check manually at:"
    echo "  https://console.cloud.google.com/apis/dashboard?project=frankie-assistant-487519"
    exit 1
fi

# Get project ID
PROJECT_ID="frankie-assistant-487519"

echo "Checking project: $PROJECT_ID"
echo ""

# Required APIs
REQUIRED_APIS=(
    "gmail.googleapis.com:Gmail API"
    "calendar-json.googleapis.com:Google Calendar API"
    "drive.googleapis.com:Google Drive API"
    "docs.googleapis.com:Google Docs API"
    "sheets.googleapis.com:Google Sheets API"
    "slides.googleapis.com:Google Slides API"
)

MISSING_APIS=()
ENABLED_APIS=()

for api_entry in "${REQUIRED_APIS[@]}"; do
    IFS=':' read -r api_name api_display <<< "$api_entry"

    if gcloud services list --project="$PROJECT_ID" --enabled --filter="name:$api_name" --format="value(name)" 2>/dev/null | grep -q "$api_name"; then
        echo "✅ $api_display"
        ENABLED_APIS+=("$api_display")
    else
        echo "❌ $api_display (NOT ENABLED)"
        MISSING_APIS+=("$api_name")
    fi
done

echo ""
echo "Summary"
echo "-------"
echo "Enabled: ${#ENABLED_APIS[@]}/6"

if [ ${#MISSING_APIS[@]} -eq 0 ]; then
    echo ""
    echo "✅ All required APIs are enabled!"
    echo ""
    echo "Next: Verify OAuth scopes at https://myaccount.google.com/permissions"
    exit 0
else
    echo "Missing: ${#MISSING_APIS[@]}/6"
    echo ""
    echo "To enable missing APIs:"
    for api in "${MISSING_APIS[@]}"; do
        echo "  gcloud services enable $api --project=$PROJECT_ID"
    done
    echo ""
    echo "Or enable manually at:"
    echo "  https://console.cloud.google.com/apis/library?project=$PROJECT_ID"
    exit 1
fi
