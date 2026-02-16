# Iframe Automation Solutions for NanoClaw

## Problem

agent-browser has limited iframe support - can't reliably interact with form fields inside iframes.

## Solutions (Ranked by Recommendation)

### Solution 1: Playwright MCP (Already Available) ⭐ RECOMMENDED

**Status**: Already installed and available via `mcp__playwright__*` tools

**Why it's better**:
- Native iframe handling - elements inside iframes get refs in snapshots
- Refs work across iframe boundaries automatically
- JavaScript evaluation can access iframe content
- Cross-origin iframe support

**How to use**:
```javascript
// 1. Navigate
mcp__playwright__browser_navigate(url: "https://example.com")

// 2. Snapshot (includes iframe elements)
mcp__playwright__browser_snapshot()
// Output includes: textbox "Email" [ref=abc] (in iframe)

// 3. Interact using ref (works in iframe automatically)
mcp__playwright__browser_type(ref: "abc", text: "test@example.com")
mcp__playwright__browser_click(ref: "def")
```

**Advantages**:
- ✅ Already configured
- ✅ No additional setup needed
- ✅ Full Playwright API
- ✅ Handle nested iframes
- ✅ Cross-origin iframe support (with evaluate)

**Limitations**:
- Cross-origin iframes may need JavaScript evaluation
- Slightly more verbose than agent-browser

---

### Solution 2: Puppeteer MCP

**Status**: Not installed (would need to add)

**Package**: `@modelcontextprotocol/server-puppeteer`

**How to add**:
```json
{
  "puppeteer": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
    "env": {}
  }
}
```

**Why it's good**:
- Similar to Playwright, excellent iframe support
- Some prefer Puppeteer's API
- Good Chrome DevTools integration

**Advantages**:
- ✅ Native iframe switching
- ✅ Frame navigation
- ✅ Mature ecosystem

**Limitations**:
- ❌ Requires installation
- ❌ Chrome/Chromium only (no Firefox)
- ❌ Less actively maintained than Playwright

---

### Solution 3: Enhanced agent-browser with Frame Commands

**Status**: Would require custom extension

**How it would work**:
```bash
# Extend agent-browser CLI
agent-browser frame list                    # List all frames
agent-browser frame switch 0                # Switch to iframe by index
agent-browser frame switch "name"           # Switch by name
agent-browser fill @e1 "text"               # Interact in current frame
agent-browser frame switch main             # Back to main frame
```

**Advantages**:
- ✅ Consistent with existing agent-browser workflow
- ✅ CLI-based (simpler for agents)

**Limitations**:
- ❌ Requires developing/maintaining custom code
- ❌ Manual frame switching (error-prone)
- ❌ No cross-origin iframe support

**Implementation effort**: Medium (1-2 hours)

---

### Solution 4: Selenium MCP

**Status**: Not available in official MCP registry

**Would need**: Custom MCP server implementation

**Advantages**:
- ✅ Industry standard for browser automation
- ✅ Excellent iframe support
- ✅ Cross-browser compatibility

**Limitations**:
- ❌ No official MCP server exists
- ❌ Would need to build custom MCP
- ❌ Heavier than Playwright/Puppeteer

**Implementation effort**: High (3-4 hours)

---

### Solution 5: Direct Playwright Script (Python/Node.js)

**Status**: Always available via Bash

**How it works**:
Create a Python script that uses Playwright directly:

```python
# /tmp/fill-iframe-form.py
from playwright.sync_api import sync_playwright

def fill_form(url, email, password):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(url)

        # Wait for iframe
        frame = page.frame_locator('iframe[name="payment-form"]')

        # Fill form in iframe
        frame.locator('input[name="email"]').fill(email)
        frame.locator('input[name="password"]').fill(password)
        frame.locator('button[type="submit"]').click()

        page.wait_for_load_state('networkidle')
        browser.close()
        return "Success"

print(fill_form("https://example.com", "user@test.com", "pass123"))
```

**Call from agent**:
```bash
python3 /tmp/fill-iframe-form.py
```

**Advantages**:
- ✅ Full control over iframe handling
- ✅ Can handle any edge case
- ✅ Reusable scripts

**Limitations**:
- ❌ Requires writing custom scripts
- ❌ Less flexible (hardcoded for specific forms)
- ❌ More maintenance

---

## Comparison Matrix

| Solution | Iframe Support | Setup | Flexibility | Maintenance |
|----------|----------------|-------|-------------|-------------|
| **Playwright MCP** | ⭐⭐⭐⭐⭐ | ✅ Ready | ⭐⭐⭐⭐⭐ | Low |
| Puppeteer MCP | ⭐⭐⭐⭐⭐ | 🔧 1 min | ⭐⭐⭐⭐ | Low |
| Enhanced agent-browser | ⭐⭐⭐ | 🛠️ 1-2 hrs | ⭐⭐⭐ | Medium |
| Selenium MCP | ⭐⭐⭐⭐⭐ | 🛠️ 3-4 hrs | ⭐⭐⭐⭐⭐ | Medium |
| Direct Scripts | ⭐⭐⭐⭐⭐ | 🛠️ Per form | ⭐⭐ | High |

---

## Recommendation

**Use Playwright MCP (Solution #1)** - It's already configured and provides excellent iframe support out of the box.

### Quick Start

Update your agent prompts to use Playwright MCP instead of agent-browser for iframe tasks:

**Before** (agent-browser - doesn't work in iframes):
```
Fill the form on this page using agent-browser
```

**After** (Playwright MCP - works in iframes):
```
Fill the form on this page using Playwright MCP tools (mcp__playwright__browser_*)
```

The agent will automatically:
1. Navigate with `mcp__playwright__browser_navigate`
2. Get snapshot with `mcp__playwright__browser_snapshot`
3. Fill fields using refs (works in iframes)
4. Click submit button

---

## Common Iframe Scenarios

### Scenario 1: Payment Form in Iframe

**Problem**: Stripe/PayPal iframes won't work with agent-browser

**Solution**: Playwright MCP with refs from snapshot

```javascript
// Snapshot includes iframe elements automatically
mcp__playwright__browser_snapshot()
// Returns: textbox "Card number" [ref=xyz] (in stripe iframe)

// Fill using ref (works across iframe boundary)
mcp__playwright__browser_type(ref: "xyz", text: "4242424242424242")
```

### Scenario 2: Cross-Origin Iframe

**Problem**: Can't access iframe content due to CORS

**Solution**: Use Playwright evaluate to inject JavaScript

```javascript
mcp__playwright__browser_evaluate(
  function: `
    try {
      const iframe = document.querySelector('iframe[src*="thirdparty.com"]');
      const doc = iframe.contentDocument;
      doc.querySelector('input').value = 'test';
      return 'Success';
    } catch(e) {
      return 'Cross-origin blocked: ' + e.message;
    }
  `
)
```

### Scenario 3: Nested Iframes (Iframe within Iframe)

**Problem**: agent-browser can't handle nested iframes

**Solution**: Playwright MCP handles this automatically via refs

```javascript
// Snapshot includes all nested elements with refs
mcp__playwright__browser_snapshot()
// Returns: button "Submit" [ref=abc] (in nested iframe)

// Click works regardless of nesting level
mcp__playwright__browser_click(ref: "abc")
```

---

## Migration Guide: agent-browser → Playwright MCP

### Command Mapping

| agent-browser | Playwright MCP | Notes |
|---------------|----------------|-------|
| `agent-browser open <url>` | `mcp__playwright__browser_navigate(url)` | Same functionality |
| `agent-browser snapshot -i` | `mcp__playwright__browser_snapshot()` | Includes iframes |
| `agent-browser click @e1` | `mcp__playwright__browser_click(ref, element)` | Ref from snapshot |
| `agent-browser fill @e1 "text"` | `mcp__playwright__browser_type(ref, text, element)` | Works in iframes |
| `agent-browser screenshot` | `mcp__playwright__browser_take_screenshot()` | Same functionality |
| `agent-browser eval "code"` | `mcp__playwright__browser_evaluate(function)` | Can access iframes |

### Example Migration

**Before** (agent-browser - fails in iframes):
```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
agent-browser fill @e1 "test@example.com"
agent-browser click @e2
```

**After** (Playwright MCP - works in iframes):
```javascript
mcp__playwright__browser_navigate(url: "https://example.com/form")
mcp__playwright__browser_snapshot()
// Returns: textbox [ref=abc], button [ref=def]
mcp__playwright__browser_type(ref: "abc", text: "test@example.com", element: "Email field")
mcp__playwright__browser_click(ref: "def", element: "Submit button")
```

---

## Troubleshooting

### Issue: "Playwright MCP tools not available"

**Check**:
1. Are tools listed in Claude Code?
2. Is Playwright MCP in settings.json?
3. Container restart needed?

**Fix**:
```bash
# Check available tools
docker exec <container> claude --list-tools | grep playwright

# If missing, add to settings.json
# (Should already be there based on system tools list)
```

### Issue: "Element not found in iframe"

**Cause**: Iframe not loaded when snapshot taken

**Fix**: Wait before snapshot
```javascript
mcp__playwright__browser_navigate(url)
mcp__playwright__browser_wait_for(time: 3)  // Wait 3 seconds
mcp__playwright__browser_snapshot()
```

### Issue: "Cross-origin iframe access blocked"

**Cause**: Browser security prevents iframe access

**Fix**: Use evaluate with try/catch
```javascript
mcp__playwright__browser_evaluate(
  function: `
    try {
      const iframe = document.querySelector('iframe');
      // ... access iframe ...
    } catch(e) {
      return 'CORS blocked - may need different approach';
    }
  `
)
```

---

## Next Steps

1. **Test Playwright MCP**: Send a test message to your agent asking it to fill a form with iframes
2. **Update instructions**: Modify your prompts to specify Playwright MCP for iframe tasks
3. **Document edge cases**: If you find iframe scenarios that don't work, document them

---

Generated: 2026-02-15
