# Unified Intelligent Agent System

A consolidated agent architecture that automatically detects and applies the appropriate functionality based on context.

## Overview

This agent system provides a truly unified approach to handling different types of AI interactions. Rather than requiring explicit agent selection, it intelligently determines which functionality to use:

- **Task Management** - If workflows are present in the resources
- **Function Calling** - If actions are present in the resources
- **Audio Transcription** - If audio is provided and capabilities.transcribe is true
- **Chat** - Default fallback functionality

This contextual intelligence eliminates the need to specify different agent types, making the system more intuitive and flexible.

## Architecture

```
                ┌─────────────────┐
                │ Unified Agent   │
                └────────┬────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  ┌─────────────────┐    ┌────────────────┐   ┌─────────────┐  │
│  │                 │    │                │   │             │  │
│  │ Resource-based  │    │ Capability-    │   │ Fallback    │  │
│  │ Detection       │    │ based          │   │ Default     │  │
│  │                 │    │ Detection      │   │             │  │
│  └──┬─────────┬────┘    └───────┬────────┘   └──────┬──────┘  │
│     │         │                 │                   │         │
│     ▼         ▼                 ▼                   ▼         │
│  ┌──────┐  ┌──────┐        ┌──────────┐         ┌──────┐     │
│  │Tasks │  │Funcs │        │ Audio    │         │ Chat │     │
│  └──────┘  └──────┘        └──────────┘         └──────┘     │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## Usage

The unified agent is used with a single function call, automatically determining the appropriate functionality:

```typescript
import unifiedAgent from 'src/api/agents/unified-agent';

// Use the agent - it automatically detects what functionality to apply
const result = await unifiedAgent.bind(context)({
  // Task management is used if workflows are present
  resources: { 
    copilotz: { 
      workflows: [/* workflow definitions */],
      // Function calling is used if actions are present
      actions: [/* action definitions */] 
    }, 
    config: { /* general config */ } 
  },
  // Transcription is used if audio is provided with transcribe capability
  audio: 'data:audio/base64...',
  capabilities: {
    transcribe: true
  },
  user: { /* user data */ },
  thread: { extId: 'thread-id' },
  input: 'User input message',
}, responseObject);
```

### Input Parameters

The agent accepts a unified set of parameters that control its behavior:

| Parameter | Type | Description |
|-----------|------|-------------|
| `resources` | object | Contains configuration, workflows, actions, etc. |
| `capabilities` | object | Features the agent can use (e.g., `transcribe: true`) |
| `user` | object | User information |
| `thread` | object | Thread information with extId |
| `input` | string | Text input from user |
| `audio` | string | Base64-encoded audio input |
| `answer` | any | Previous answer context |
| `threadLogs` | array | History of conversation |
| `instructions` | string | Custom instructions for agent |
| `options` | object | Additional options |
| `actionModules` | object | Custom action modules (for function calling) |
| `inputSchema` | object | JSON schema for input validation |
| `outputSchema` | object | JSON schema for output validation |

### Context

The agent requires a context object bound using `.bind()`:

| Property | Description |
|----------|-------------|
| `models` | Database models (tasks, workflows, etc.) |
| `modules` | Service modules (agents, AI providers, etc.) |
| `utils` | Utility functions |
| `withHooks` | Function to apply hooks to agents |
| `env` | Environment variables |
| `__requestId__` | Request identifier |
| `__executionId__` | Execution identifier |

## Intelligent Detection Flow

The unified agent makes decisions in this order:

1. **Audio Transcription** - If `audio` exists and `capabilities.transcribe` is true
2. **Task Management** - If resources contain `workflows` property
3. **Function Calling** - If resources contain `actions` property 
4. **Chat** - Default fallback if no specialized functionality is needed

This means you can provide all necessary resources and the agent will correctly apply multiple features as needed.

## Key Features

1. **Context-Aware Intelligence**: Automatically selects the appropriate functionality
2. **Unified Interface**: Single entry point for all capabilities
3. **Simplified Usage**: No need to specify agent type explicitly
4. **Type Safety**: Full TypeScript typing for all parameters and return values
5. **Modular Design**: Each function is independent and reusable
6. **Functional Approach**: Pure functions with clear inputs/outputs
7. **Error Handling**: Comprehensive error handling with appropriate status codes

## Utilities

The agent system provides several utility functions:

- `jsonSchemaToShortSchema`: Converts JSON Schema to Short Schema format
- `mergeSchemas`: Merges two schemas together
- `createPrompt`: Creates prompts from templates
- `mentionsExtractor`: Extracts mentions from text
- `getThreadHistory`: Retrieves conversation history
- `base64ToBlob`: Converts base64 audio to Blob format

## Examples

### Automatic Task Management

```typescript
const result = await unifiedAgent.bind(context)({
  resources: { 
    copilotz: {
      workflows: [
        { name: 'Onboarding', description: 'Customer onboarding process' }
      ]
    },
    config 
  },
  user,
  thread: { extId: 'thread-123' },
  input: 'Start the onboarding workflow',
}, res);
```

### Automatic Function Calling

```typescript
const result = await unifiedAgent.bind(context)({
  resources: { 
    copilotz: {
      actions: [
        { 
          spec: '(calculates math expression): !expression<string>->(result)',
          moduleUrl: '/math-calculator.js' 
        }
      ]
    },
    config
  },
  user,
  thread: { extId: 'thread-123' },
  input: 'Calculate 2+2',
}, res);
```

### Automatic Audio Transcription

```typescript
const result = await unifiedAgent.bind(context)({
  resources: { config },
  capabilities: {
    transcribe: true
  },
  user,
  thread: { extId: 'thread-123' },
  audio: 'data:audio/wav;base64,SGVsbG8gV29ybGQ=',
}, res);
```

### Default Chat

```typescript
const result = await unifiedAgent.bind(context)({
  resources: { 
    copilotz: { name: 'Assistant', backstory: 'I am a helpful AI' },
    config 
  },
  user,
  thread: { extId: 'thread-123' },
  input: 'Tell me a joke',
}, res);
``` 