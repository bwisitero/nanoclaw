#!/bin/bash
# MCP Configuration Validator
# Validates that all MCP servers have proper environment variable configuration

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

echo "🔍 Validating MCP configuration..."
echo ""

# Check if required files exist
if [ ! -f ".env" ]; then
  echo -e "${RED}✗ .env file not found${NC}"
  exit 1
fi

if [ ! -f "src/container-runner.ts" ]; then
  echo -e "${RED}✗ src/container-runner.ts not found${NC}"
  exit 1
fi

# Extract env vars from .env (exclude comments and empty lines)
echo "📋 Checking .env file..."
ENV_VARS=$(grep -v '^#' .env | grep -v '^$' | grep '=' | cut -d= -f1 | sort)
ENV_VAR_COUNT=$(echo "$ENV_VARS" | wc -l | tr -d ' ')
echo "   Found $ENV_VAR_COUNT environment variables"

# Extract allowedVars from container-runner.ts
echo "📋 Checking allowedVars in container-runner.ts..."
ALLOWED_VARS=$(grep -A 20 "const allowedVars = \[" src/container-runner.ts | grep "'" | sed "s/.*'\([^']*\)'.*/\1/" | sort)
ALLOWED_VAR_COUNT=$(echo "$ALLOWED_VARS" | wc -l | tr -d ' ')
echo "   Found $ALLOWED_VAR_COUNT allowed variables"

# Check for env vars that should be in allowedVars
echo ""
echo "🔐 Validating API keys are in allowedVars..."
for var in $ENV_VARS; do
  # Skip non-secret vars and service-level configs
  if [[ "$var" == "ASSISTANT_NAME" ]] || \
     [[ "$var" == "TELEGRAM_ONLY" ]] || \
     [[ "$var" == "TELEGRAM_BOT_TOKEN" ]]; then
    continue
  fi

  if ! echo "$ALLOWED_VARS" | grep -q "^${var}$"; then
    echo -e "   ${RED}✗ $var is in .env but NOT in allowedVars${NC}"
    echo -e "      ${YELLOW}Add to src/container-runner.ts allowedVars array${NC}"
    ERRORS=$((ERRORS + 1))
  fi
done

# Check MCP server configs directly in container-runner.ts
echo ""
echo "🔌 Checking MCP server configurations in template..."

# Check Tavily MCP
if grep -q "tavily:" src/container-runner.ts; then
  echo "   ✓ Tavily MCP found"
  if grep -A 10 "tavily:" src/container-runner.ts | grep -q "TAVILY_API_KEY"; then
    echo "     ✓ Has env section with TAVILY_API_KEY"
  else
    echo -e "     ${RED}✗ Missing env section with TAVILY_API_KEY${NC}"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo -e "   ${YELLOW}⚠ Tavily MCP not found (optional)${NC}"
  WARNINGS=$((WARNINGS + 1))
fi

# Check Google Workspace MCP
if grep -q "'google-workspace'" src/container-runner.ts; then
  echo "   ✓ Google Workspace MCP found"
  MISSING_GOOGLE_VARS=""
  if ! grep -A 10 "'google-workspace'" src/container-runner.ts | grep -q "GOOGLE_WORKSPACE_CLIENT_ID"; then
    MISSING_GOOGLE_VARS="${MISSING_GOOGLE_VARS}CLIENT_ID "
  fi
  if ! grep -A 10 "'google-workspace'" src/container-runner.ts | grep -q "GOOGLE_WORKSPACE_CLIENT_SECRET"; then
    MISSING_GOOGLE_VARS="${MISSING_GOOGLE_VARS}CLIENT_SECRET "
  fi
  if ! grep -A 10 "'google-workspace'" src/container-runner.ts | grep -q "GOOGLE_WORKSPACE_REFRESH_TOKEN"; then
    MISSING_GOOGLE_VARS="${MISSING_GOOGLE_VARS}REFRESH_TOKEN "
  fi

  if [ -z "$MISSING_GOOGLE_VARS" ]; then
    echo "     ✓ Has env section with all required Google vars"
  else
    echo -e "     ${RED}✗ Missing env vars: $MISSING_GOOGLE_VARS${NC}"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo -e "   ${YELLOW}⚠ Google Workspace MCP not found (optional)${NC}"
  WARNINGS=$((WARNINGS + 1))
fi

# Check for MCP servers in existing group settings
echo ""
echo "📁 Checking existing group configurations..."
for settings_file in data/sessions/*/. claude/settings.json; do
  if [ -f "$settings_file" ]; then
    GROUP=$(echo "$settings_file" | cut -d/ -f3)
    echo "   Checking $GROUP..."

    # Check if MCP servers exist
    if ! grep -q "mcpServers" "$settings_file"; then
      echo -e "     ${YELLOW}⚠ No mcpServers section found${NC}"
      WARNINGS=$((WARNINGS + 1))
      continue
    fi

    # Check Tavily
    if grep -q '"tavily"' "$settings_file"; then
      if grep -A 5 '"tavily"' "$settings_file" | grep -q "TAVILY_API_KEY"; then
        echo "     ✓ Tavily configured with env"
      else
        echo -e "     ${RED}✗ Tavily missing env section${NC}"
        ERRORS=$((ERRORS + 1))
      fi
    fi

    # Check Google Workspace
    if grep -q '"google-workspace"' "$settings_file"; then
      GOOGLE_ENV_COUNT=$(grep -A 10 '"google-workspace"' "$settings_file" | grep "GOOGLE_WORKSPACE_" | wc -l | tr -d ' ')
      if [ "$GOOGLE_ENV_COUNT" -ge 3 ]; then
        echo "     ✓ Google Workspace configured with env"
      else
        echo -e "     ${RED}✗ Google Workspace missing env section (found $GOOGLE_ENV_COUNT/3 vars)${NC}"
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi
done

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo -e "${GREEN}✓ All MCP configurations are valid!${NC}"
  exit 0
elif [ $ERRORS -eq 0 ]; then
  echo -e "${YELLOW}⚠ $WARNINGS warning(s) found (non-critical)${NC}"
  exit 0
else
  echo -e "${RED}✗ $ERRORS error(s) found${NC}"
  if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}⚠ $WARNINGS warning(s) found${NC}"
  fi
  echo ""
  echo "Please review the errors above and fix them."
  echo "See .claude/skills/add-mcp/CHECKLIST.md for guidance."
  exit 1
fi
