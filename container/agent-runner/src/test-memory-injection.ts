/**
 * Memory Injection Test Suite
 *
 * Validates query classification and injection behavior.
 */

import { classifyQuery, shouldInjectMemory } from './query-classifier.js';

interface TestCase {
  query: string;
  expectedType: 'greeting' | 'code' | 'recall' | 'general';
  expectedInjection: boolean;
}

const testQueries: TestCase[] = [
  // Greetings - should skip injection
  { query: 'hello', expectedType: 'greeting', expectedInjection: false },
  { query: 'hi there', expectedType: 'greeting', expectedInjection: false },
  { query: 'thanks!', expectedType: 'greeting', expectedInjection: false },
  { query: 'thank you so much', expectedType: 'greeting', expectedInjection: false },
  { query: 'good morning', expectedType: 'greeting', expectedInjection: false },
  { query: 'bye', expectedType: 'greeting', expectedInjection: false },

  // Code tasks - should skip injection
  { query: 'refactor the login function', expectedType: 'code', expectedInjection: false },
  { query: 'fix the bug in checkout', expectedType: 'code', expectedInjection: false },
  { query: 'implement user authentication', expectedType: 'code', expectedInjection: false },
  { query: 'debug this error', expectedType: 'code', expectedInjection: false },
  { query: 'write code to parse JSON', expectedType: 'code', expectedInjection: false },
  { query: 'install the dependencies', expectedType: 'code', expectedInjection: false },
  { query: 'deploy to production', expectedType: 'code', expectedInjection: false },

  // Code with recall - should inject
  { query: 'refactor the login function where we discussed OAuth', expectedType: 'recall', expectedInjection: true },
  { query: 'fix the bug you mentioned last time', expectedType: 'recall', expectedInjection: true },
  { query: 'implement what we talked about before', expectedType: 'recall', expectedInjection: true },

  // Recall queries - should inject
  { query: 'where do I upload documents?', expectedType: 'recall', expectedInjection: true },
  { query: 'who handles my loan?', expectedType: 'recall', expectedInjection: true },
  { query: 'what did we decide about authentication?', expectedType: 'recall', expectedInjection: true },
  { query: 'remember when we discussed John Lee?', expectedType: 'recall', expectedInjection: true },
  { query: 'when is the deadline?', expectedType: 'recall', expectedInjection: true },
  { query: 'what was the URL you told me before?', expectedType: 'recall', expectedInjection: true },
  { query: 'who did you mention earlier?', expectedType: 'recall', expectedInjection: true },

  // General queries - should inject
  { query: 'how should we containerize this?', expectedType: 'general', expectedInjection: true },
  { query: 'tell me about the project structure', expectedType: 'general', expectedInjection: true },
  { query: 'explain the architecture', expectedType: 'general', expectedInjection: true },
  { query: 'any updates on the deployment?', expectedType: 'general', expectedInjection: true },
  { query: 'summarize the current status', expectedType: 'general', expectedInjection: true },
];

async function runTests() {
  console.log('Running memory injection tests...\n');

  let passed = 0;
  let failed = 0;

  for (const test of testQueries) {
    const queryType = classifyQuery(test.query);
    const shouldInject = shouldInjectMemory(queryType, 'smart');

    const typeMatch = queryType === test.expectedType;
    const injectionMatch = shouldInject === test.expectedInjection;

    if (typeMatch && injectionMatch) {
      console.log(`✅ PASS: "${test.query}"`);
      console.log(`   Type: ${queryType}, Inject: ${shouldInject}\n`);
      passed++;
    } else {
      console.log(`❌ FAIL: "${test.query}"`);
      console.log(`   Expected: type=${test.expectedType}, inject=${test.expectedInjection}`);
      console.log(`   Got: type=${queryType}, inject=${shouldInject}\n`);
      failed++;
    }
  }

  // Test different modes
  console.log('\n--- Testing Different Modes ---\n');

  const testQuery = 'hello there';
  const queryType = classifyQuery(testQuery);

  const automaticMode = shouldInjectMemory(queryType, 'automatic');
  const smartMode = shouldInjectMemory(queryType, 'smart');
  const manualMode = shouldInjectMemory(queryType, 'manual');

  console.log(`Query: "${testQuery}" (type: ${queryType})`);
  console.log(`- automatic mode: ${automaticMode ? '✅ inject' : '❌ skip'} (expected: inject)`);
  console.log(`- smart mode: ${smartMode ? '✅ inject' : '❌ skip'} (expected: skip)`);
  console.log(`- manual mode: ${manualMode ? '✅ inject' : '❌ skip'} (expected: skip)`);

  if (automaticMode && !smartMode && !manualMode) {
    console.log('✅ PASS: Mode behavior correct\n');
    passed++;
  } else {
    console.log('❌ FAIL: Mode behavior incorrect\n');
    failed++;
  }

  // Summary
  console.log('\n=== Test Summary ===');
  console.log(`Total: ${testQueries.length + 1} tests`);
  console.log(`Passed: ${passed}/${testQueries.length + 1}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success rate: ${Math.round((passed / (testQueries.length + 1)) * 100)}%`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
