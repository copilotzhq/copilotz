/**
 * Agents Index - Main entry point for the agents system
 * 
 * This module exports a unified intelligent agent system which:
 * - Automatically detects and selects the appropriate functionality 
 * - Combines chat, function calling, task management, and audio transcription
 * - Decides which functionality to use based on context
 * 
 * The agent intelligently selects functionality:
 * - If resources have workflow property → use task management
 * - If resources have actions property → use function calling
 * - If capabilities.transcribe === true → process audio input
 * - Otherwise, falls back to basic chat
 */

import unifiedAgent, {
  transcribeAudio,
  chatWithAI,
  handleFunctionCalls,
  manageTask,
  
  // Utilities
  jsonSchemaToShortSchema,
  mergeSchemas,
  createPrompt,
  mentionsExtractor,
  getThreadHistory,
  sleep,
  base64ToBlob
} from './unified-agent.ts';

import middleware from './middleware.ts';

// Export the unified agent as the default export
export default unifiedAgent;

// Export individual components for direct access if needed
export {
  // Agent implementations
  transcribeAudio,
  chatWithAI,
  handleFunctionCalls,
  manageTask,
  
  // Middleware
  middleware,
  
  // Utilities
  jsonSchemaToShortSchema,
  mergeSchemas,
  createPrompt,
  mentionsExtractor,
  getThreadHistory,
  sleep,
  base64ToBlob
};

/**
 * Legacy support for direct agent type selection
 * This is for backward compatibility with existing code
 * 
 * Note: These functions can still be used directly but will depend on 
 * the unified agent's context detection
 */
export const agents = {
  chat: chatWithAI,
  functionCall: handleFunctionCalls,
  taskManager: manageTask,
  transcriber: transcribeAudio
}; 