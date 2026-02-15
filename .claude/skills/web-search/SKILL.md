# Web Search

Search the internet using Tavily's powerful search API. Get real-time information, news, facts, and research results.

## What This Does

The `/web-search` skill uses Tavily MCP to search the web and return relevant, up-to-date information. Tavily is optimized for AI agents and provides:
- Real-time search results
- High-quality, relevant content
- Automatic content extraction and summarization
- Support for news, general search, and research queries

## When to Use

Use `/web-search` when you need:
- Current information (news, events, prices, weather)
- Facts that aren't in your training data
- Research on specific topics
- Verification of information
- Finding specific resources, tools, or services

## Usage

**Simple search:**
```
/web-search latest AI news
```

**Specific query:**
```
/web-search what is the current price of Bitcoin
```

**Research query:**
```
/web-search best practices for container security 2026
```

## Implementation

When the user runs `/web-search <query>`, use the Tavily MCP tools available in your environment:

1. **Use `mcp__tavily__search`** - Main search tool
   - Input: `query` (string) - The search query
   - Optional: `search_depth` ("basic" or "advanced") - Default is "basic"
   - Optional: `topic` ("general" or "news") - Default is "general"
   - Optional: `max_results` (number) - Max results to return (default 5)
   - Returns: List of results with title, URL, content, and relevance score

2. **Format the results** - Present results in a clean, readable format:
   ```
   *Search Results for: [query]*

   1. *[Title]*
      [Summary of content]
      Source: [URL]

   2. *[Title]*
      [Summary of content]
      Source: [URL]
   ```

3. **Provide synthesis** - If multiple results, synthesize key findings:
   ```
   *Key Findings:*
   • [Main point 1]
   • [Main point 2]
   • [Main point 3]
   ```

## Examples

**User:** `/web-search best MCP servers for Claude`

**Assistant:**
```
*Search Results for: best MCP servers for Claude*

1. *Official Anthropic MCP Servers*
   The Model Context Protocol (MCP) lets Claude connect to external tools and data.
   Anthropic maintains official servers for filesystem, GitHub, and more.
   Source: https://github.com/anthropic-ai/mcp-servers

2. *Community MCP Directory*
   A curated list of 50+ MCP servers including database connectors, API integrations,
   and productivity tools.
   Source: https://mcp.directory

*Key Findings:*
• Official servers are most reliable (filesystem, GitHub, database)
• Popular community servers: Tavily (search), Slack, Google Workspace
• All servers use the same MCP protocol, so they're interchangeable
```

**User:** `/web-search current bitcoin price`

**Assistant:**
```
*Search Results for: current bitcoin price*

1. *Bitcoin Price Live*
   Bitcoin (BTC) is currently trading at $52,340 USD, up 2.3% in the last 24 hours.
   Source: https://www.coindesk.com/price/bitcoin

*Key Finding:*
• Bitcoin is at $52,340 USD (as of Feb 14, 2026, 7:45 PM)
```

## Advanced Options

**Search depth:**
- `basic` - Fast, general results (default)
- `advanced` - More comprehensive, deeper research

**Topic filtering:**
- `general` - All types of content (default)
- `news` - Only recent news articles

**Example with options:**
```
/web-search --advanced --news latest AI regulations
```

When implementing, use:
```typescript
mcp__tavily__search({
  query: "latest AI regulations",
  search_depth: "advanced",
  topic: "news",
  max_results: 10
})
```

## Error Handling

If Tavily API fails:
1. Check if TAVILY_API_KEY is set (it should be passed via secrets)
2. Verify the MCP server is configured in settings.json
3. Fall back to suggesting the user check manually

**Fallback message:**
```
I couldn't reach the search API right now. You can search manually at:
https://www.google.com/search?q=[query]

Or check the Tavily API status if you're seeing this repeatedly.
```

## Notes

- Tavily is optimized for AI agents - results are pre-processed and summarized
- The API key is automatically passed to the container via environment variables
- Search results are real-time and may include very recent content
- For fact-checking, always cite sources with URLs
- The MCP server runs via npx (remote hosted) - no local installation needed

## Tips

- Be specific in queries - "Bitcoin price Feb 2026" is better than "Bitcoin"
- Use advanced search for research tasks, basic for quick facts
- Combine multiple searches for comprehensive research
- Always cite sources when presenting facts from search results
- Use news topic for time-sensitive information
