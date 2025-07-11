import type { ProviderName } from './types.ts';

// Model capability types
export type ModelCapability = 'thinking' | 'vision' | 'audio' | 'image-gen' | 'audio-gen';
export type ModelSize = 'nano' | 'small' | 'medium' | 'large';
export type ReasoningLevel = 0 | 1 | 2 | 3; // 0 = none, 1 = low, 2 = medium, 3 = high
export type ReasoningEffort = 'low' | 'medium' | 'high' | null;

// Table-based model definition - each row is a model
export interface ModelRecord {
  name: string;
  provider: ProviderName;
  size: ModelSize;
  // Capability flags
  vision: boolean;
  audio: boolean;
  imageGen: boolean; // renamed from 'image-gen' for valid JS property
  audioGen: boolean; // renamed from 'audio-gen' for valid JS property
  reasoning: ReasoningLevel; // 0-3 scale
  // OpenAI-specific reasoning configuration
  reasoningEffort?: ReasoningEffort;
  // Additional metadata
  contextWindow?: number;
  costTier?: 'free' | 'low' | 'medium' | 'high';
  costPerMInputTokens?: number;
  costPerMOutputTokens?: number;
}

// Model configuration that includes reasoning effort
export interface ModelConfig {
  model: string;
  reasoningEffort?: ReasoningEffort;
}

// Comprehensive model table - each entry is a model with all its capabilities
export const MODEL_TABLE: ModelRecord[] = [
    {
      "name": "gpt-4.1",
      "provider": "openai",
      "size": "large",
      "vision": true,
      "audio": false,
      "imageGen": true,
      "audioGen": false,
      "reasoning": 2,
      "reasoningEffort": null,
      "contextWindow": 1000000,
      "costPerMInputTokens": 2.0,
      "costPerMOutputTokens": 8.0,
      "costTier": "medium"
    },
    {
      "name": "gpt-4.1-mini",
      "provider": "openai",
      "size": "small",
      "vision": true,
      "audio": false,
      "imageGen": true,
      "audioGen": false,
      "reasoning": 1,
      "reasoningEffort": null,
      "contextWindow": 1000000,
      "costPerMInputTokens": 0.4,
      "costPerMOutputTokens": 1.6,
      "costTier": "low"
    },
    {
        "name": "gpt-4.1-nano",
        "provider": "openai",
        "size": "nano",
        "vision": true,
        "audio": false,
        "imageGen": true,
        "audioGen": false,
        "reasoning": 1,
        "reasoningEffort": null,
        "contextWindow": 1000000,
        "costPerMInputTokens": 0.1,
        "costPerMOutputTokens": 0.4,
        "costTier": "low"
      },
    {
      "name": "gpt-4o",
      "provider": "openai",
      "size": "large",
      "vision": true,
      "audio": true,
      "imageGen": true,
      "audioGen": false,
      "reasoning": 2,
      "reasoningEffort": null,
      "contextWindow": 128000,
      "costPerMInputTokens": 5.0,
      "costPerMOutputTokens": 20.0,
      "costTier": "high"
    },
    {
      "name": "gpt-4o-mini",
      "provider": "openai",
      "size": "small",
      "vision": true,
      "audio": true,
      "imageGen": true,
      "audioGen": false,
      "reasoning": 1,
      "reasoningEffort": null,
      "contextWindow": 128000,
      "costPerMInputTokens": 0.6,
      "costPerMOutputTokens": 2.4,
      "costTier": "low"
    },
    {
      "name": "o3",
      "provider": "openai",
      "size": "large",
      "vision": true,
      "audio": false,
      "imageGen": true,
      "audioGen": false,
      "reasoning": 3,
      "reasoningEffort": "high",
      "contextWindow": 200000,
      "costPerMInputTokens": 2.0,
      "costPerMOutputTokens": 8.0,
      "costTier": "medium"
    },
    {
        "name": "o3",
        "provider": "openai",
        "size": "medium",
        "vision": true,
        "audio": false,
        "imageGen": true,
        "audioGen": false,
        "reasoning": 2,
        "reasoningEffort": "low",
        "contextWindow": 200000,
        "costPerMInputTokens": 2.0,
        "costPerMOutputTokens": 8.0,
        "costTier": "medium"
      },
    {
        "name": "o3",
        "provider": "openai",
        "size": "medium",
        "vision": true,
        "audio": false,
        "imageGen": true,
        "audioGen": false,
        "reasoning": 3,
        "reasoningEffort": "medium",
        "contextWindow": 200000,
        "costPerMInputTokens": 2.0,
        "costPerMOutputTokens": 8.0,
        "costTier": "medium"
      },
    {
        "name": "o3",
        "provider": "openai",
        "size": "medium",
        "vision": true,
        "audio": false,
        "imageGen": false,
        "audioGen": false,
        "reasoning": 3,
        "reasoningEffort": "high",
        "contextWindow": 200000,
        "costPerMInputTokens": 2.0,
        "costPerMOutputTokens": 8.0,
        "costTier": "medium"
      },
    {
      "name": "o4-mini",
      "provider": "openai",
      "size": "small",
      "vision": true,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 1,
      "reasoningEffort": "low",
      "contextWindow": 200000,
      "costPerMInputTokens": 1.1,
      "costPerMOutputTokens": 4.4,
      "costTier": "medium"
    },
    {
        "name": "o4-mini",
        "provider": "openai",
        "size": "small",
        "vision": true,
        "audio": false,
        "imageGen": false,
        "audioGen": false,
        "reasoning": 2,
        "reasoningEffort": "medium",
        "contextWindow": 200000,
        "costPerMInputTokens": 1.1,
        "costPerMOutputTokens": 4.4,
        "costTier": "medium"
      },
      {
        "name": "o4-mini",
        "provider": "openai",
        "size": "small",
        "vision": true,
        "audio": false,
        "imageGen": true,
        "audioGen": false,
        "reasoning": 3,
        "reasoningEffort": "high",
        "contextWindow": 200000,
        "costPerMInputTokens": 1.1,
        "costPerMOutputTokens": 4.4,
        "costTier": "medium"
      },
    {
      "name": "gemini-2.5-pro",
      "provider": "gemini",
      "size": "medium",
      "vision": true,
      "audio": true,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 2,
      "contextWindow": 1048576,
      "costPerMInputTokens": 1.25,
      "costPerMOutputTokens": 10.0,
      "costTier": "medium"
    },
    {
      "name": "gemini-2.5-flash",
      "provider": "gemini",
      "size": "small",
      "vision": true,
      "audio": true,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 1,
      "contextWindow": 1048576,
      "costPerMInputTokens": 0.3,
      "costPerMOutputTokens": 2.5,
      "costTier": "low"
    },
    {
        "name": "gemini-2.5-flash-lite",
        "provider": "gemini",
        "size": "nano",
        "vision": true,
        "audio": true,
        "imageGen": false,
        "audioGen": false,
        "reasoning": 1,
        "contextWindow": 1048576,
        "costPerMInputTokens": 0.1,
        "costPerMOutputTokens": 0.4,
        "costTier": "low"
      },
    {
      "name": "grok-3",
      "provider": "xai",
      "size": "large",
      "vision": true,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 2,
      "contextWindow": 131072,
      "costPerMInputTokens": 3.0,
      "costPerMOutputTokens": 15.0,
      "costTier": "high"
    },
    {
      "name": "grok-3-mini",
      "provider": "xai",
      "size": "small",
      "vision": true,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 1,
      "contextWindow": 131072,
      "costPerMInputTokens": 0.3,
      "costPerMOutputTokens": 0.5,
      "costTier": "low"
    },
    {
      "name": "claude-4-opus",
      "provider": "anthropic",
      "size": "large",
      "vision": true,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 3,
      "contextWindow": 200000,
      "costPerMInputTokens": 15.0,
      "costPerMOutputTokens": 75.0,
      "costTier": "high"
    },
    {
      "name": "claude-4-sonnet",
      "provider": "anthropic",
      "size": "medium",
      "vision": true,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 2,
      "contextWindow": 200000,
      "costPerMInputTokens": 3.0,
      "costPerMOutputTokens": 15.0,
      "costTier": "medium"
    },
    {
      "name": "claude-3.5-sonnet",
      "provider": "anthropic",
      "size": "medium",
      "vision": true,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 2,
      "contextWindow": 200000,
      "costPerMInputTokens": 3.0,
      "costPerMOutputTokens": 15.0,
      "costTier": "medium"
    },
    {
      "name": "llama-3.1-405b",
      "provider": "ollama",
      "size": "large",
      "vision": false,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 1,
      "contextWindow": 128000,
      "costPerMInputTokens": 0.0,
      "costPerMOutputTokens": 0.0,
      "costTier": "free"
    },
    {
      "name": "llama-3.1-70b",
      "provider": "ollama",
      "size": "medium",
      "vision": false,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 1,
      "contextWindow": 128000,
      "costPerMInputTokens": 0.0,
      "costPerMOutputTokens": 0.0,
      "costTier": "free"
    },
    {
      "name": "llama-3.1-8b",
      "provider": "ollama",
      "size": "small",
      "vision": false,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 0,
      "contextWindow": 128000,
      "costPerMInputTokens": 0.0,
      "costPerMOutputTokens": 0.0,
      "costTier": "free"
    },
    {
      "name": "r1",
      "provider": "deepseek",
      "size": "medium",
      "vision": false,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 2,
      "contextWindow": 64000,
      "costPerMInputTokens": 0.55,
      "costPerMOutputTokens": 2.19,
      "costTier": "medium"
    },
    {
      "name": "v3",
      "provider": "deepseek",
      "size": "small",
      "vision": false,
      "audio": false,
      "imageGen": false,
      "audioGen": false,
      "reasoning": 1,
      "contextWindow": 64000,
      "costPerMInputTokens": 0.27,
      "costPerMOutputTokens": 1.10,
      "costTier": "low"
    }
  ];

/**
 * Query models by any combination of properties
 * Returns all models that match the provided criteria
 */
export function queryModels(criteria: Partial<ModelRecord>): ModelRecord[] {
  return MODEL_TABLE.filter(model => {
    return Object.entries(criteria).every(([key, value]) => {
      const modelValue = model[key as keyof ModelRecord];
      return modelValue === value;
    });
  });
} 