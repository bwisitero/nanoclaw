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
export declare function classifyQuery(prompt: string): QueryType;
/**
 * Determine if memory should be injected based on query type and mode.
 *
 * @param queryType - The classified query type
 * @param mode - The memory injection mode (automatic | smart | manual)
 * @returns boolean - true if memory should be injected
 */
export declare function shouldInjectMemory(queryType: QueryType, mode: 'automatic' | 'smart' | 'manual'): boolean;
//# sourceMappingURL=query-classifier.d.ts.map