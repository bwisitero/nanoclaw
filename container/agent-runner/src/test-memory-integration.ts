/**
 * Memory Integration Test Suite
 *
 * Tests the full memory injection pipeline with real database queries.
 */

import { hybridMemorySearch, formatMemoryContext, estimateTokens } from './memory-hybrid-search.js';
import { loadMemoryConfig } from '../../../src/memory-config.js';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = '/Users/emil/Documents/NanoClaw/nanoclaw/store/messages.db';
const TEST_GROUP = 'groups/main';

async function testDatabaseConnection() {
  console.log('\n=== Test 1: Database Connection ===');

  if (!fs.existsSync(DB_PATH)) {
    console.log('❌ FAIL: Database not found at', DB_PATH);
    return false;
  }

  try {
    const db = new Database(DB_PATH, { readonly: true });

    // Check for required tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map((t: any) => t.name);

    const requiredTables = ['document_chunks', 'document_chunks_fts', 'messages', 'messages_fts'];
    const missingTables = requiredTables.filter(t => !tableNames.includes(t));

    if (missingTables.length > 0) {
      console.log('❌ FAIL: Missing tables:', missingTables);
      db.close();
      return false;
    }

    // Check for data
    const docCount = db.prepare('SELECT COUNT(*) as count FROM document_chunks').get() as { count: number };
    const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };

    console.log('✅ PASS: Database connected');
    console.log(`   - Documents: ${docCount.count} chunks`);
    console.log(`   - Messages: ${msgCount.count} messages`);

    db.close();
    return true;
  } catch (error) {
    console.log('❌ FAIL: Database error:', error);
    return false;
  }
}

async function testConfigLoading() {
  console.log('\n=== Test 2: Config Loading ===');

  try {
    const config = loadMemoryConfig(TEST_GROUP);

    console.log('✅ PASS: Config loaded');
    console.log(`   - Mode: ${config.injection.mode}`);
    console.log(`   - Max tokens: ${config.injection.maxTokens}`);
    console.log(`   - Vector weight: ${config.hybridSearch.vectorWeight}`);
    console.log(`   - Temporal decay: ${config.hybridSearch.temporalDecay}`);

    return true;
  } catch (error) {
    console.log('❌ FAIL: Config loading error:', error);
    return false;
  }
}

async function testFTS5Search() {
  console.log('\n=== Test 3: FTS5 Keyword Search ===');

  try {
    const db = new Database(DB_PATH, { readonly: true });

    // Test escape function
    const testQuery = 'test query with "quotes"';
    const escaped = testQuery
      .replace(/"/g, '""')
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"`)
      .join(' ');

    console.log(`   Query: "${testQuery}" → "${escaped}"`);

    // Try a simple search
    const results = db.prepare(`
      SELECT COUNT(*) as count
      FROM document_chunks_fts
      WHERE document_chunks_fts MATCH ?
    `).get(escaped) as { count: number };

    console.log(`✅ PASS: FTS5 query executed`);
    console.log(`   - Results: ${results.count} matches`);

    db.close();
    return true;
  } catch (error) {
    console.log('❌ FAIL: FTS5 search error:', error);
    return false;
  }
}

async function testFormatting() {
  console.log('\n=== Test 4: Memory Formatting ===');

  try {
    const mockResults = [
      {
        source: 'documents' as const,
        content: 'This is a test document with some content about memory systems.',
        snippet: 'test document with some content',
        timestamp: Date.now(),
        relevanceScore: 0.95,
        path: 'test.md',
      },
      {
        source: 'conversations' as const,
        content: 'User asked about memory and agent responded with explanation.',
        snippet: 'asked about memory',
        timestamp: Date.now() - 86400000, // 1 day ago
        relevanceScore: 0.85,
      },
    ];

    const formatted = formatMemoryContext(mockResults, 500);
    const tokens = estimateTokens(formatted);

    console.log('✅ PASS: Formatting works');
    console.log(`   - Input: ${mockResults.length} results`);
    console.log(`   - Output: ${formatted.length} chars`);
    console.log(`   - Estimated tokens: ${tokens}`);
    console.log(`   - Preview: ${formatted.slice(0, 100)}...`);

    return true;
  } catch (error) {
    console.log('❌ FAIL: Formatting error:', error);
    return false;
  }
}

async function testHybridSearch() {
  console.log('\n=== Test 5: Hybrid Search (without embeddings) ===');

  // This will test graceful degradation to keyword-only
  try {
    // Use a test query that should match something in the database
    const testQuery = 'memory system';

    console.log(`   Query: "${testQuery}"`);
    console.log('   Note: Vector search will timeout (expected), falling back to keywords');

    const results = await hybridMemorySearch(
      testQuery,
      TEST_GROUP,
      'test-chat-jid'
    );

    console.log('✅ PASS: Hybrid search executed');
    console.log(`   - Results: ${results.length} items`);

    if (results.length > 0) {
      console.log(`   - Top result: ${results[0].source}`);
      console.log(`   - Relevance: ${results[0].relevanceScore.toFixed(3)}`);
      console.log(`   - Snippet: ${results[0].snippet.slice(0, 80)}...`);
    }

    return true;
  } catch (error) {
    console.log('❌ FAIL: Hybrid search error:', error);
    return false;
  }
}

async function runIntegrationTests() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  Memory Integration Test Suite        ║');
  console.log('╚════════════════════════════════════════╝');

  const results = [
    await testDatabaseConnection(),
    await testConfigLoading(),
    await testFTS5Search(),
    await testFormatting(),
    await testHybridSearch(),
  ];

  const passed = results.filter(r => r).length;
  const failed = results.length - passed;

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  Test Summary                          ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Total: ${results.length} tests`);
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success rate: ${Math.round((passed / results.length) * 100)}%`);

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Review errors above.');
    process.exit(1);
  } else {
    console.log('\n✅ All integration tests passed!');
    process.exit(0);
  }
}

runIntegrationTests();
