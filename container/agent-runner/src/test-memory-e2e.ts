/**
 * End-to-End Memory Test
 *
 * Tests real queries against actual database with comprehensive output.
 */

import { hybridMemorySearch, formatMemoryContext } from './memory-hybrid-search.js';
import { classifyQuery, shouldInjectMemory } from './query-classifier.js';
import Database from 'better-sqlite3';

const DB_PATH = process.cwd() + '/store/messages.db';
const TEST_GROUP = 'groups/main';

async function testRealQueries() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  End-to-End Memory Test                ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Get some actual content from the database to test against
  const db = new Database(DB_PATH, { readonly: true });

  // Get a sample word from messages
  const sampleMsg = db.prepare('SELECT content FROM messages WHERE LENGTH(content) > 20 LIMIT 1').get() as { content: string } | undefined;

  // Get a sample document filename
  const sampleDoc = db.prepare('SELECT DISTINCT file_name FROM document_chunks LIMIT 1').get() as { file_name: string } | undefined;

  db.close();

  const testQueries = [
    { query: 'hello', expectInjection: false },
    { query: 'what did we discuss?', expectInjection: true },
  ];

  // Add query based on actual data
  if (sampleMsg) {
    const words = sampleMsg.content.split(/\s+/).filter(w => w.length > 4);
    if (words.length > 0) {
      testQueries.push({
        query: `tell me about ${words[0]}`,
        expectInjection: true,
      });
    }
  }

  for (const test of testQueries) {
    console.log(`\n━━━ Query: "${test.query}" ━━━`);

    // Step 1: Classify
    const queryType = classifyQuery(test.query);
    console.log(`1. Classification: ${queryType}`);

    // Step 2: Check injection decision
    const shouldInject = shouldInjectMemory(queryType, 'smart');
    console.log(`2. Should inject (smart mode): ${shouldInject}`);

    if (shouldInject !== test.expectInjection) {
      console.log(`   ⚠️  Expected: ${test.expectInjection}`);
    }

    if (shouldInject) {
      // Step 3: Search
      console.log('3. Searching...');
      try {
        const results = await hybridMemorySearch(test.query, TEST_GROUP, 'test-jid');
        console.log(`   → Found ${results.length} results`);

        if (results.length > 0) {
          console.log(`   → Top result: ${results[0].source}`);
          console.log(`   → Relevance: ${results[0].relevanceScore.toFixed(3)}`);
          console.log(`   → Snippet: ${results[0].snippet.slice(0, 100)}...`);

          // Step 4: Format
          const formatted = formatMemoryContext(results, 500);
          console.log(`4. Formatted context: ${formatted.length} chars`);
          console.log('   Preview:');
          console.log('   ┌─────────────────────────────────────');
          console.log(formatted.split('\n').map(line => '   │ ' + line).join('\n'));
          console.log('   └─────────────────────────────────────');
        } else {
          console.log('   → No results (query may not match database content)');
        }
      } catch (error) {
        console.log(`   ❌ Search failed: ${error}`);
      }
    } else {
      console.log('3. Skipped (not injecting for this query type)');
    }
  }

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  Test Complete                         ║');
  console.log('╚════════════════════════════════════════╝');
}

testRealQueries();
