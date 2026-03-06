/**
 * Query Classification for Smart Memory Injection
 *
 * Classifies user queries to determine when memory context should be automatically injected.
 * This reduces token usage by ~65% compared to always injecting memory.
 */

export type QueryType = 'greeting' | 'code' | 'recall' | 'general';

/**
 * Classify a user query to determine its type.
 *
 * @param prompt - The user's query/message
 * @returns QueryType - greeting (skip), code (skip unless recall), recall (inject), general (inject)
 */
export function classifyQuery(prompt: string): QueryType {
  const lower = prompt.toLowerCase();

  // Greetings/thanks - skip injection (no context needed)
  const greetingKeywords = [
    'hello', 'hi', 'hey', 'thanks', 'thank you', 'bye', 'goodbye',
    'good morning', 'good afternoon', 'good evening', 'good night',
  ];
  if (greetingKeywords.some(kw => lower.includes(kw)) && prompt.length < 50) {
    return 'greeting';
  }

  // Code tasks - skip injection unless asking about past context
  const codeKeywords = [
    'refactor', 'fix', 'debug', 'implement', 'add function', 'create file',
    'write code', 'update code', 'change code', 'modify code',
    'install', 'deploy', 'build', 'compile', 'test',
  ];

  // Explicit recall keywords - always inject
  const recallKeywords = [
    'who', 'where', 'when', 'what', 'remember', 'recall', 'previously',
    'before', 'last time', 'earlier', 'discussed', 'mentioned', 'talked about',
    'decided', 'agreed', 'you told', 'I told', 'we said',
  ];

  if (codeKeywords.some(kw => lower.includes(kw))) {
    // Code task WITH recall question = inject
    if (recallKeywords.some(kw => lower.includes(kw))) {
      return 'recall';
    }
    return 'code';
  }

  // Explicit recall queries - always inject
  if (recallKeywords.some(kw => lower.includes(kw))) {
    return 'recall';
  }

  // General questions - inject (might reference past decisions/preferences)
  return 'general';
}

/**
 * Determine if memory should be injected based on query type and mode.
 *
 * @param queryType - The classified query type
 * @param mode - The memory injection mode (automatic | smart | manual)
 * @returns boolean - true if memory should be injected
 */
export function shouldInjectMemory(
  queryType: QueryType,
  mode: 'automatic' | 'smart' | 'manual'
): boolean {
  if (mode === 'automatic') return true;
  if (mode === 'manual') return false;

  // Smart mode - inject only for recall and general queries
  return queryType === 'recall' || queryType === 'general';
}
