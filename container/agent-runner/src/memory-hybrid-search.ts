/**
 * Hybrid Memory Search (OpenClaw Pattern)
 *
 * Combines vector search (semantic similarity) and BM25 keyword search (FTS5)
 * with weighted scoring, temporal decay, and MMR diversity filtering.
 *
 * Architecture:
 * - Vector search: Via IPC to host (cosine similarity with embeddings)
 * - Keyword search: FTS5 full-text search (BM25 ranking)
 * - Graceful degradation: Falls back to keyword-only if embeddings unavailable
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { loadMemoryConfig } from './memory-config.js';

export interface SearchResult {
  source: 'facts' | 'conversations' | 'documents';
  content: string;
  snippet: string;
  timestamp: number;
  relevanceScore: number;
  path?: string;
}

/**
 * Hybrid memory search combining vector and keyword search.
 *
 * @param query - User's query
 * @param groupFolder - Group folder path (e.g., 'groups/main')
 * @param chatJid - Chat JID for conversation search
 * @returns Array of search results sorted by relevance
 */
export async function hybridMemorySearch(
  query: string,
  groupFolder: string,
  chatJid: string
): Promise<SearchResult[]> {
  const config = loadMemoryConfig(`/workspace/${groupFolder}`);

  try {
    // Step 1: Parallel search (vector + keyword)
    const [vectorResults, keywordResults] = await Promise.all([
      searchWithEmbeddings(query, groupFolder, config.injection.maxResults * 2),
      searchWithFTS5(query, groupFolder, chatJid, config.injection.maxResults * 2),
    ]);

    // Step 2: Merge with weighted scoring
    let merged = mergeResults(
      vectorResults,
      keywordResults,
      config.hybridSearch.vectorWeight,
      config.hybridSearch.keywordWeight
    );

    // Step 3: Apply temporal decay if enabled
    if (config.hybridSearch.temporalDecay) {
      merged = applyTemporalDecay(merged, config.hybridSearch.halfLifeDays, config.evergreen);
    }

    // Step 4: MMR re-ranking for diversity if enabled
    if (config.hybridSearch.mmrReranking) {
      merged = mmrRerank(merged, config.hybridSearch.mmrLambda, config.injection.maxResults);
    } else {
      merged = merged.slice(0, config.injection.maxResults);
    }

    // Step 5: Filter by relevance threshold
    return merged.filter(r => r.relevanceScore >= config.injection.relevanceThreshold);

  } catch (embeddingError) {
    console.error('[Memory] Embeddings unavailable, falling back to keyword-only search:', embeddingError);
    // Graceful degradation: BM25-only
    const keywordResults = await searchWithFTS5(query, groupFolder, chatJid, config.injection.maxResults);
    return keywordResults.filter(r => r.relevanceScore >= config.injection.relevanceThreshold);
  }
}

/**
 * Search using semantic embeddings via IPC.
 */
async function searchWithEmbeddings(query: string, groupFolder: string, limit: number): Promise<SearchResult[]> {
  const searchId = `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const taskFile = `/workspace/ipc/tasks/${searchId}.json`;
  const resultFile = `/workspace/ipc/results/${searchId}.json`;

  // Write IPC task
  fs.writeFileSync(taskFile, JSON.stringify({
    type: 'semantic_search',
    query,
    groupFolder,
    limit,
    searchId,
    timestamp: new Date().toISOString(),
  }));

  // Poll for results (max 5 seconds for injection, faster than tool's 15s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));

    if (fs.existsSync(resultFile)) {
      const results = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      fs.unlinkSync(resultFile);

      if (results.error) {
        throw new Error(results.error);
      }

      return (results.results || []).map((r: any) => ({
        source: 'documents' as const,
        content: r.content,
        snippet: r.content.slice(0, 200),
        timestamp: Date.now(), // TODO: extract from metadata
        relevanceScore: r.score || r.similarity || 0,
        path: r.file_name || r.file_path,
      }));
    }
  }

  throw new Error('Semantic search timeout');
}

/**
 * Search using FTS5 full-text search.
 */
async function searchWithFTS5(query: string, groupFolder: string, chatJid: string, limit: number): Promise<SearchResult[]> {
  // Try container path first, fall back to host path for testing
  let dbPath = '/workspace/project/store/messages.db';
  if (!fs.existsSync(dbPath)) {
    // Running outside container - use relative path from project root
    dbPath = path.join(process.cwd(), 'store/messages.db');
  }

  const db = new Database(dbPath, { readonly: true });

  try {
    // Escape FTS5 query
    const escapedQuery = fts5Escape(query);

    // Extract just the folder name from path (e.g., "groups/main" -> "main")
    const folderName = groupFolder.split('/').pop() || groupFolder;

    // Search documents
    const docResults = db.prepare(`
      SELECT
        dc.file_name,
        dc.content,
        snippet(document_chunks_fts, 0, '>>>', '<<<', '...', 32) as snippet,
        rank as relevanceScore
      FROM document_chunks_fts
      JOIN document_chunks dc ON document_chunks_fts.rowid = dc.rowid
      WHERE document_chunks_fts MATCH ? AND dc.group_folder = ?
      ORDER BY rank
      LIMIT ?
    `).all(escapedQuery, folderName, Math.floor(limit / 2));

    // Search conversations
    const convResults = db.prepare(`
      SELECT
        m.sender_name,
        m.content,
        snippet(messages_fts, 0, '>>>', '<<<', '...', 32) as snippet,
        m.timestamp,
        rank as relevanceScore
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      WHERE messages_fts MATCH ? AND m.chat_jid = ?
      ORDER BY rank
      LIMIT ?
    `).all(escapedQuery, chatJid, Math.floor(limit / 2));

    db.close();

    // Search memory files (facts.md, conversation summaries, etc.)
    const memoryResults = searchMemoryFiles(query, folderName, Math.floor(limit / 3));

    return [
      ...docResults.map((r: any) => ({
        source: 'documents' as const,
        content: r.content,
        snippet: r.snippet.replace(/>>>/g, '').replace(/<<</g, ''),
        timestamp: Date.now(), // TODO: parse from file
        relevanceScore: Math.abs(r.relevanceScore), // FTS5 rank is negative
        path: r.file_name,
      })),
      ...convResults.map((r: any) => ({
        source: 'conversations' as const,
        content: r.content,
        snippet: r.snippet.replace(/>>>/g, '').replace(/<<</g, ''),
        timestamp: new Date(r.timestamp).getTime(),
        relevanceScore: Math.abs(r.relevanceScore),
      })),
      ...memoryResults,
    ];
  } catch (error) {
    throw error;
  }
}

/**
 * Search memory files (facts.md, conversation summaries, etc.)
 * Uses simple text matching since these are curated, important files.
 */
function searchMemoryFiles(query: string, groupFolder: string, limit: number): SearchResult[] {
  // Try container path first, fall back to host path for testing
  let memoryPath = `/workspace/group/memory`;
  if (!fs.existsSync(memoryPath)) {
    // Running outside container - construct path from group folder
    const basePath = process.cwd();
    memoryPath = path.join(basePath, 'groups', groupFolder, 'memory');
  }

  if (!fs.existsSync(memoryPath)) {
    return []; // No memory directory yet
  }

  const results: SearchResult[] = [];
  const queryLower = query.toLowerCase();
  const queryTokens = tokenize(query);

  try {
    const files = fs.readdirSync(memoryPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(memoryPath, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const contentLower = content.toLowerCase();

      // Check if query matches
      if (!contentLower.includes(queryLower) && !queryTokens.some(token => contentLower.includes(token))) {
        continue;
      }

      // Find best matching snippet (context around match)
      const lines = content.split('\n');
      let bestMatch = '';
      let bestScore = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineLower = line.toLowerCase();

        // Score based on query token matches
        const matchCount = queryTokens.filter(token => lineLower.includes(token)).length;
        if (matchCount > bestScore) {
          bestScore = matchCount;
          // Get context: current line + 1 line before/after
          const contextLines = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2));
          bestMatch = contextLines.join(' ').slice(0, 200);
        }
      }

      if (bestScore > 0) {
        // Relevance score: higher if more tokens match, boost for facts.md
        let relevanceScore = bestScore * 2; // Base score from token matches
        if (file === 'facts.md') {
          relevanceScore *= 1.5; // Boost facts.md (curated important info)
        }

        results.push({
          source: 'facts' as const,
          content: content.slice(0, 1000), // First 1000 chars
          snippet: bestMatch,
          timestamp: fs.statSync(filePath).mtimeMs,
          relevanceScore,
          path: `memory/${file}`,
        });
      }

      if (results.length >= limit) break;
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  } catch (error) {
    console.error('[Memory] Error searching memory files:', error);
    return [];
  }
}

/**
 * Merge vector and keyword results with weighted scoring.
 */
function mergeResults(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  vectorWeight: number,
  keywordWeight: number
): SearchResult[] {
  // Normalize scores to 0-1 range
  const maxVectorScore = Math.max(...vectorResults.map(r => r.relevanceScore), 1);
  const maxKeywordScore = Math.max(...keywordResults.map(r => r.relevanceScore), 1);

  const vectorMap = new Map(vectorResults.map(r => [
    r.snippet,
    { ...r, relevanceScore: r.relevanceScore / maxVectorScore }
  ]));

  const keywordMap = new Map(keywordResults.map(r => [
    r.snippet,
    { ...r, relevanceScore: r.relevanceScore / maxKeywordScore }
  ]));

  // Combine scores
  const allKeys = new Set([...vectorMap.keys(), ...keywordMap.keys()]);
  const merged: SearchResult[] = [];

  for (const key of allKeys) {
    const vResult = vectorMap.get(key);
    const kResult = keywordMap.get(key);

    if (vResult && kResult) {
      // Both sources found it - combine scores
      merged.push({
        ...vResult,
        relevanceScore: (vectorWeight * vResult.relevanceScore) + (keywordWeight * kResult.relevanceScore),
      });
    } else if (vResult) {
      // Only vector found it
      merged.push({
        ...vResult,
        relevanceScore: vectorWeight * vResult.relevanceScore,
      });
    } else if (kResult) {
      // Only keyword found it
      merged.push({
        ...kResult,
        relevanceScore: keywordWeight * kResult.relevanceScore,
      });
    }
  }

  return merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Apply temporal decay to favor recent memories.
 */
function applyTemporalDecay(
  results: SearchResult[],
  halfLifeDays: number,
  evergreenPatterns: string[]
): SearchResult[] {
  return results.map(result => {
    // Skip evergreen files
    if (result.path && evergreenPatterns.some(pattern => result.path?.includes(pattern))) {
      return result;
    }

    // Calculate decay
    const ageInDays = (Date.now() - result.timestamp) / (1000 * 60 * 60 * 24);
    const lambda = Math.log(2) / halfLifeDays;
    const decay = Math.exp(-lambda * ageInDays);

    return {
      ...result,
      relevanceScore: result.relevanceScore * decay,
    };
  }).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * MMR (Maximal Marginal Relevance) re-ranking for diversity.
 * Balances relevance vs diversity to avoid redundant results.
 */
function mmrRerank(results: SearchResult[], lambda: number, limit: number): SearchResult[] {
  const selected: SearchResult[] = [];
  const remaining = [...results];

  while (selected.length < limit && remaining.length > 0) {
    let bestScore = -Infinity;
    let bestIndex = -1;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].relevanceScore;

      // Max similarity to already selected results
      const maxSim = selected.length === 0 ? 0 : Math.max(
        ...selected.map(s => jaccardSimilarity(remaining[i].snippet, s.snippet))
      );

      // MMR formula: balance relevance vs diversity
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }

    if (bestIndex !== -1) {
      selected.push(remaining.splice(bestIndex, 1)[0]);
    }
  }

  return selected;
}

/**
 * Calculate Jaccard similarity between two text snippets.
 */
function jaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(tokenize(text1));
  const tokens2 = new Set(tokenize(text2));
  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Tokenize text into words.
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\b\w+\b/g) || [];
}

/**
 * Escape user input for FTS5 MATCH queries.
 * Wraps each token in double-quotes to make them literal.
 */
function fts5Escape(query: string): string {
  return query
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(' ');
}

/**
 * Format memory results for injection into system prompt.
 */
export function formatMemoryContext(results: SearchResult[], maxTokens: number): string {
  let output = '';
  let tokenCount = 0;

  for (const result of results) {
    const entry = `**[${result.source}]** ${result.snippet}\n`;
    const entryTokens = estimateTokens(entry);

    if (tokenCount + entryTokens > maxTokens) break;

    output += entry;
    tokenCount += entryTokens;
  }

  return output.trim();
}

/**
 * Estimate token count (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
