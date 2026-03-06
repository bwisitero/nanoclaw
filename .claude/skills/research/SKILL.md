# Research

Systematic approach to gathering, evaluating, and synthesizing information from multiple web sources into clear, accurate, insight-driven answers with proper source evaluation.

## When to Use

This skill should be invoked when:
user says research, investigate, find out about, compare, what's the current state of, give me a deep dive, look into, who currently holds, current events, recent changes

## Instructions

## Research Skill - Systematic Information Gathering

Use this skill when the user asks to research a topic, compare options, investigate a question, or produce output requiring information synthesis from multiple sources.

**Triggers:** "research X", "find out about Y", "compare A vs B", "what's the current state of Z", "give me a deep dive on...", "investigate...", "look into...", current events, recent changes, who holds a role/position.

**Do NOT use for:** Simple factual questions answerable from memory, pure coding tasks, or creative writing with no research component.

---

### Phase 1: Query Decomposition (Before Searching)

Before calling any search tool, decompose the request:

1. **Core question:** What is the actual information need?
2. **Sub-questions:** Most requests contain 2-5 underlying questions
3. **Time-sensitive vs stable:** Stable facts don't need search; current status always does
4. **Output format:** Paragraph? Comparison table? Structured report? File?
5. **Recency requirement:** Yesterday's data vs. real-time info?

**Rule:** Never search what you know reliably and hasn't changed. Never skip search for what could have changed since training.

---

### Phase 2: Search Strategy

Scale searches to complexity:

| Query Type | Search Count | Strategy |
|---|---|---|
| Single fact/current status | 1 | Search, verify, answer |
| Multi-angle topic | 3-5 | Search main topic, drill sub-topics |
| Deep research/comparison | 5-10+ | Build research plan, execute systematically |
| Comprehensive report | 10-15 | Treat as research project with sections |

**Search Execution Rules:**
- Keep queries short and specific: 1-6 words
- Start broad, narrow on follow-up
- Every query must be meaningfully different
- Use `mcp__tavily__tavily_extract` for full content when snippets are shallow
- Include temporal context when needed: "2026", "latest", "current"
- Never use operators (-, site:, quotes) unless explicitly required
- Stop when you have enough (diminishing returns)

**Always Search For:**
- Who currently holds a position/role/office
- Current pricing, availability, product specs
- Recent events, news, policy changes, elections
- Whether company/person/project still exists/is active
- Any binary fact where training data could be wrong

---

### Phase 3: Source Evaluation

**Tier 1 - Primary Sources (highest trust):**
- Official documentation, .gov sites, regulatory filings (SEC, FDA)
- Company official blogs, press releases, investor relations
- Peer-reviewed academic papers

**Tier 2 - Established Journalism:**
- Reuters, AP, Bloomberg, FT, WSJ, NYT, The Economist
- Established trade publications (TechCrunch, Politico, etc.)

**Tier 3 - Community/Aggregators:**
- Wikipedia (good for overview, verify specifics)
- Stack Overflow, Reddit (useful for sentiment/experience)
- Industry blogs with clear expertise

**Red Flags:**
- Content farms, SEO spam sites
- Undated articles on time-sensitive topics
- Single anonymous source with no corroboration
- Extreme bias without counterbalancing sources

---

### Phase 4: Synthesis & Output

**Structure your answer:**
1. **Direct answer first** - Answer the core question in 1-2 sentences
2. **Evidence & detail** - Support with findings from searches
3. **Source attribution** - Cite sources inline: "According to [Source]..."
4. **Caveats** - Note limitations, conflicting info, or uncertainty
5. **Recency note** - When data was gathered (if time-sensitive)

**Quality Checks:**
- Did you answer the actual question asked?
- Did you cite Tier 1/2 sources for key claims?
- Did you acknowledge conflicting information?
- Is output format appropriate? (If user wants a file, create one)
- Would user need to search again, or is this sufficient?

---

### Phase 5: Execution

1. **Decompose** the user's request (Phase 1)
2. **Plan searches** based on complexity (Phase 2)
3. **Execute searches** using `mcp__tavily__tavily_search` (max_results: 5-10)
4. **Use `mcp__tavily__tavily_extract`** for full article content when needed
5. **Evaluate sources** (Phase 3) - prioritize Tier 1/2
6. **Synthesize** findings into clear output (Phase 4)
7. **Create file** if user wants saved report: `/workspace/group/research-[topic]-[date].md`

**Example Flow:**

User: "Research whether Tesla is still the EV market leader in 2026"

1. Decompose:
   - Core: Tesla's current EV market position
   - Sub-questions: 2026 market share, competitors, sales data
   - Time-sensitive: Yes (current status)
   - Output: Paragraph with data

2. Search plan:
   - Search 1: "Tesla EV market share 2026"
   - Search 2: "top EV manufacturers 2026 sales"
   - Search 3: "BYD vs Tesla 2026" (if BYD emerges as competitor)

3. Execute with `mcp__tavily__tavily_search`

4. Synthesize with source attribution

5. Deliver clear answer with caveats

---

**Tools to use:**
- `mcp__tavily__tavily_search` - Main search tool
- `mcp__tavily__tavily_extract` - Get full article content
- `mcp__tavily__tavily_research` - For comprehensive deep dives
- `Write` - Create research report files when appropriate

**Remember:** Quality > quantity. 3 good searches beat 10 mediocre ones.

## Notes

- This skill was created via the `create_skill` tool
- Edit this file directly to modify the skill behavior
- Skills are available immediately after creation

## Usage

```
/research
```
