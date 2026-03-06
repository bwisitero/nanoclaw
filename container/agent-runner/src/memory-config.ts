import * as fs from 'fs';
import * as path from 'path';

export interface MemoryConfig {
  injection: {
    mode: 'automatic' | 'smart' | 'manual'; // smart = default
    maxTokens: number; // 500 default
    maxResults: number; // 10 default
    relevanceThreshold: number; // 0.3 default
  };
  hybridSearch: {
    vectorWeight: number; // 0.6 default
    keywordWeight: number; // 0.4 default
    temporalDecay: boolean; // true default
    halfLifeDays: number; // 30 default
    mmrReranking: boolean; // true default
    mmrLambda: number; // 0.7 default
  };
  evergreen: string[]; // ['CLAUDE.md', 'memory/facts.md'] default
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  injection: {
    mode: 'smart',
    maxTokens: 500,
    maxResults: 10,
    relevanceThreshold: 0.3,
  },
  hybridSearch: {
    vectorWeight: 0.6,
    keywordWeight: 0.4,
    temporalDecay: true,
    halfLifeDays: 30,
    mmrReranking: true,
    mmrLambda: 0.7,
  },
  evergreen: ['CLAUDE.md', 'memory/facts.md'],
};

/**
 * Load memory configuration for a group.
 * If no config file exists, returns default configuration.
 *
 * @param groupFolder - Path to the group folder (e.g., 'groups/main')
 * @returns Merged configuration with user overrides applied to defaults
 */
export function loadMemoryConfig(groupFolder: string): MemoryConfig {
  const configPath = path.join(groupFolder, 'memory-config.json');

  if (fs.existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Deep merge user config with defaults
      return {
        injection: { ...DEFAULT_MEMORY_CONFIG.injection, ...userConfig.injection },
        hybridSearch: { ...DEFAULT_MEMORY_CONFIG.hybridSearch, ...userConfig.hybridSearch },
        evergreen: userConfig.evergreen ?? DEFAULT_MEMORY_CONFIG.evergreen,
      };
    } catch (error) {
      console.error(`[Memory Config] Failed to parse ${configPath}, using defaults:`, error);
      return DEFAULT_MEMORY_CONFIG;
    }
  }

  return DEFAULT_MEMORY_CONFIG;
}
