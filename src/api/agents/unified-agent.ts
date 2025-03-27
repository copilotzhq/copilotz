// unified-agent.ts
// Consolidated agent module that combines taskManager, functionCall, chat, and transcriber
// ========================================================================================

import { jsonrepair } from "npm:jsonrepair";
import validate, { getDotNotationObject } from "axion-modules/connectors/validator.ts";
import lodash from "npm:lodash";

// ========================================================================================
// TYPES DEFINITIONS
// ========================================================================================

export type AgentType = 'taskManager' | 'functionCall' | 'chat' | 'transcriber' | string;

export interface Thread {
  extId: string;
  [key: string]: any;
}

export interface User {
  [key: string]: any;
}

export interface Models {
  tasks: any;
  workflows: any;
  steps: any;
  actions: any;
  jobs: any;
  logs: any;
  [key: string]: any;
}

export interface Config {
  streamResponseBy?: 'token' | 'turn';
  AI_CHAT_PROVIDER?: {
    provider: string;
    fallbackProvider?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface Copilotz {
  name?: string;
  backstory?: string;
  actions?: any[];
  job?: {
    role?: string;
    goal?: string;
    description?: string;
    workflows?: any[];
    actions?: any[];
    _id?: string;
    [key: string]: any;
  };
  workflows?: any[];
  [key: string]: any;
}

export interface Resources {
  copilotz?: Copilotz;
  config?: Config;
  [key: string]: any;
}

export interface ActionModule {
  (args: any, ...rest: any[]): Promise<any> | any;
  spec?: string;
  [key: string]: any;
}

export interface ActionModules {
  [key: string]: ActionModule;
}

export interface AgentOptions {
  [key: string]: any;
}

export interface LogEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Capabilities {
  transcribe?: boolean;
  [key: string]: any;
}

export interface BaseAgentParams {
  resources: Resources;
  user: User;
  thread: Thread;
  input?: string;
  audio?: string;
  answer?: any;
  threadLogs?: LogEntry[];
  instructions?: string;
  options?: AgentOptions;
  capabilities?: Capabilities;
  agentType?: AgentType;
  iterations?: number;
  inputSchema?: any;
  outputSchema?: any;
  overrideBaseInputSchema?: any;
  overrideBaseOutputSchema?: any;
  actionModules?: ActionModules;
  [key: string]: any;
}

export interface AgentContext {
  models: Models;
  modules: {
    agents: (agentType: string) => Promise<any>;
    ai: (type: string, provider: string) => Promise<any>;
    actionExecutor: (params: any, res: ResponseObject) => Promise<any>;
    [key: string]: any;
  };
  utils: {
    createPrompt: (template: string, data: any, options?: any) => string;
    getThreadHistory: (threadId: string, options: any) => Promise<LogEntry[]>;
    jsonSchemaToShortSchema: (schema: any, options?: any) => any;
    mergeSchemas: (schema1: any, schema2: any) => any;
    mentionsExtractor: (params: { input: string }) => string[] | null;
    sleep: (ms: number) => Promise<void>;
    _: typeof lodash;
    [key: string]: any;
  };
  withHooks: <T>(agent: T) => T;
  env: Record<string, any>;
  __tags__?: {
    turnId?: string;
    [key: string]: any;
  };
  __requestId__?: string;
  __executionId__?: string;
  [key: string]: any;
}

export interface ResponseObject {
  stream: (chunk: string) => void;
  status?: (code: number) => void;
  statusText?: (text: string) => void;
  redirect?: (url: string) => void;
  [key: string]: any;
}

export interface FunctionResult {
  name: string;
  args: Record<string, any>;
  status: 'pending' | 'ok' | 'failed';
  startTime?: number;
  results?: any;
}

// ========================================================================================
// UTILITY FUNCTIONS
// ========================================================================================

// Shared utility functions previously in shared.js
function jsonSchemaToShortSchema(jsonSchema: any, { detailed }: { detailed?: boolean } = {}): any {
  detailed = detailed ?? false;

  function convertType(type: string): string {
    switch (type) {
      case 'string': return 'string';
      case 'number':
      case 'integer': return 'number';
      case 'boolean': return 'boolean';
      case 'object': return 'object';
      case 'array': return 'array';
      case 'null': return 'null';
      default: return 'any';
    }
  }

  function formatProperties(properties: any, required: string[] = []): any {
    const result: Record<string, any> = {};
    for (const key in properties) {
      const prop = properties[key];
      const type = convertType(prop.type);
      const isRequired = required.includes(key);
      const suffix = isRequired ? '!' : '?';
      const description = detailed && prop.description ? ` ${prop.description}` : '';
      
      if (type === 'object' && prop.properties) {
        result[key] = formatProperties(prop.properties, prop.required);
      } else if (type === 'array' && prop.items) {
        result[key] = [formatProperties(prop.items.properties, prop.items.required)];
      } else {
        result[key] = description ? `<${type + suffix}>${description}</${type + suffix}>` : type + suffix;
      }
    }
    return result;
  }

  return formatProperties(jsonSchema.properties, jsonSchema.required);
}

function mergeSchemas(schema1: any, schema2: any): any {
  // Helper function to merge properties
  function mergeProperties(prop1: any, prop2: any): any {
    const merged = { ...prop1, ...prop2 };
    if (Array.isArray(prop1) && Array.isArray(prop2)) {
      return mergeArrays(prop1, prop2);
    } else if (prop1.properties && prop2.properties) {
      merged.properties = mergeSchemas(prop1.properties, prop2.properties);
    }
    return merged;
  }

  // Helper function to merge arrays without duplicates
  function mergeArrays(arr1: any[], arr2: any[]): any[] {
    return Array.from(new Set([...(arr1 || []), ...(arr2 || [])]));
  }

  // Merge the main properties of the schemas
  const mergedSchema = {
    ...schema1,
    ...schema2,
    properties: {
      ...schema1.properties,
      ...schema2.properties
    },
    required: mergeArrays(schema1.required, schema2.required)
  };

  // Merge individual properties
  for (const key in schema1.properties) {
    if (schema2.properties[key]) {
      mergedSchema.properties[key] = mergeProperties(schema1.properties[key], schema2.properties[key]);
    }
  }

  return mergedSchema;
}

function createPrompt(
  template: string, 
  data: Record<string, any>, 
  options: { removeUnusedVariables?: boolean } = { removeUnusedVariables: false }
): string {
  return template.replace(/\{\{(\w+)\}\}/g, function (match, key) {
    if (data[key] !== undefined) {
      return data[key];
    } else if (options.removeUnusedVariables) {
      return '';
    } else {
      return match;
    }
  });
}

const mentionsExtractor = ({ input }: { input: string }): string[] | null => {
  // Regex matches mentions that:
  // - Do not have a word character or dot before them
  // - Start with @ followed by one or more word characters, optionally followed by dots or hyphens
  // - Do not end with a dot, ensuring the mention is properly captured
  const mentionRegex = /(?<![\w.])@\w[\w-]*(?<!\.)/g;
  return input.match(mentionRegex);
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Convert base64 audio to Blob (from transcriber agent)
const base64ToBlob = (base64: string): Blob => {
  if (typeof base64 !== 'string') {
    throw new Error('Invalid base64 input: expected string');
  }

  const parts = base64.split(',');
  if (parts.length !== 2) {
    console.error(
      '[base64ToBlob] Invalid base64 format:',
      base64.substring(0, 50) + '...'
    );
    throw new Error(
      'Invalid base64 format: expected "data:mimetype;base64,<data>"'
    );
  }
  const [mimeTypeHeader, base64Data] = base64.split(',');
  const mimeTypeMatch = mimeTypeHeader.match(/:(.*?);/);
  if (!mimeTypeMatch) {
    throw new Error('Invalid MIME type in base64 string');
  }
  const mimeType = mimeTypeMatch[1];

  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
};

// ========================================================================================
// AGENT TEMPLATE DEFINITIONS
// ========================================================================================

// Chat agent templates
const chatPromptTemplate = `
{{instructions}}
================
{{copilotPrompt}}
================
{{currentDatePrompt}}
================
`;

const copilotPromptTemplate = `
## YOUR IDENTITY

Your name is {{name}}. Here's your backstory:
<backstory>
{{backstory}}
</backstory>

## YOUR JOB

Here's your job details:
<job>
Goal: {{jobGoal}}
Role: {{jobRole}}
Job Description:
{{jobDescription}}
</job>
`;

const currentDatePromptTemplate = `
Current Date Time:
<currentDate>
{{currentDate}}
</currentDate>
`;

// Function call templates
const functionCallPromptTemplate = `
{{responseFormatPrompt}}

{{functionCallsPrompt}}

================

{{instructions}}
`;

const functionCallsPromptTemplate = `
## FUNCTION CALLS

Available Functions:
{{availableFunctions}}
`;

// Task manager templates
const currentTaskPromptTemplate = `
## CURRENT TASK

You are managing a task for the workflow: 

<workflow>
{{workflow}}
</workflow>

Description: 
<workflowDescription>
{{workflowDescription}}
</workflowDescription>

Here are all steps in this workflow: 
<steps>
{{steps}}
</steps>

### Current Step
<stepName>
{{stepName}}
</stepName>

Instructions:
<instructions>
{{stepInstructions}}
</instructions>

Submit when: 
<submitWhen>
{{submitWhen}}
</submitWhen>

Context:
<context>
{{context}}
</context>
`;

const availableWorkflowsTemplate = `
## AVAILABLE WORKFLOWS

The user doesn't have an active task. You can help them choose from these workflows:

{{workflows}}

If the user's message indicates they want to start one of these workflows, use the createTask function to start it.
`;

// Base schemas
const _baseInputSchema = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'The message from the user'
    }
  },
  required: ['message']
};

const _baseOutputSchema = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'The message to the user'
    },
    functions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the function to call'
          },
          args: {
            type: 'object',
            description: 'The arguments for the function call'
          }
        },
        required: ['name', 'args']
      },
      description: 'The functions to call'
    },
    nextTurn: {
      type: 'string',
      enum: ['user', 'assistant'],
      description: 'Who should take the next turn'
    }
  },
  required: ['message']
};

export function responseFormatPromptTemplate({ outputSchema, inputSchema }: { outputSchema: any, inputSchema: any }, shortSchemaFn: Function): string {
  return `
## RESPONSE FORMAT

Your response must follow this format:
\`\`\`json
${JSON.stringify(shortSchemaFn(outputSchema, { detailed: true }), null, 2)}
\`\`\`

User input format:
\`\`\`json
${JSON.stringify(shortSchemaFn(inputSchema, { detailed: true }), null, 2)}
\`\`\`
`;
}

// ========================================================================================
// AGENT IMPLEMENTATIONS
// ========================================================================================

/**
 * Transcriber Agent - Converts audio into text
 */
async function transcribeAudio(
  context: AgentContext,
  params: BaseAgentParams,
  res: ResponseObject
): Promise<{ message: string; prompt?: any; consumption?: any }> {
  const { resources, instructions, audio, agentType = 'transcriber' } = params;
  const { modules, env, __requestId__ } = context;
  const { ai } = modules;
  const { config } = resources;

  if (!audio) {
    console.error('[transcribeAudio] No audio input provided');
    throw new Error('No audio input provided');
  }

  const provider = config?.AI_CHAT_PROVIDER?.provider || 'openai';
  const transcriber = (await ai('speechToText', provider)).bind({
    __requestId__,
    config: {
      apiKey:
        config?.[`${provider}_CREDENTIALS`]?.apiKey || // check for custom credentials in config
        env?.[`${provider}_CREDENTIALS_apiKey`], // use default credentials from env
    },
  });

  const audioBlob = base64ToBlob(audio);
  
  const transcribedAudio = await transcriber({
    blob: audioBlob,
    instructions,
  });

  console.log(
    `[transcribeAudio] Transcribed audio with ${transcribedAudio.duration} hours`
  );

  // Ensure 'message' is a string
  const message =
    typeof transcribedAudio.text === 'string'
      ? transcribedAudio.text
      : JSON.stringify(transcribedAudio.text);

  // Prepare prompt as an array of messages
  const prompt = [
    {
      role: 'system' as const,
      content: instructions || '',
    },
    {
      role: 'user' as const,
      content: '[Audio Input]',
    },
  ];

  // Return response in consistent format
  return {
    prompt,
    message,
    consumption: {
      type: 'hours',
      value: transcribedAudio.duration,
    },
  };
}

/**
 * Chat Agent - Handles simple text-based interactions
 */
async function chatWithAI(
  context: AgentContext,
  params: BaseAgentParams,
  res: ResponseObject
): Promise<{ message: string; input?: string; consumption?: any; __tags__?: any }> {
  const {
    resources,
    instructions,
    input,
    audio,
    user,
    inputSchema,
    outputSchema,
    overrideBaseInputSchema,
    overrideBaseOutputSchema,
    thread,
    threadLogs = [],
    answer,
    agentType = 'chat',
    options,
    capabilities = {},
  } = params;

  const {
    __tags__,
    __requestId__,
    __executionId__,
    withHooks,
    modules,
    utils,
    env,
  } = context;

  // Extract utils and dependencies
  const { createPrompt, getThreadHistory } = utils;
  const { ai, agents } = modules;
  const { copilotz, config } = resources;

  // Handle base schemas
  const baseInputSchema = overrideBaseInputSchema || _baseInputSchema;
  const baseOutputSchema = overrideBaseOutputSchema || _baseOutputSchema;
  const finalInputSchema = inputSchema ? mergeSchemas(baseInputSchema, inputSchema) : baseInputSchema;
  const finalOutputSchema = outputSchema ? mergeSchemas(baseOutputSchema, outputSchema) : baseOutputSchema;

  // Set thread and turn IDs
  const localTags = __tags__ || {};
  if (!localTags.turnId) localTags.turnId = __executionId__;
  const { extId: threadId } = thread;

  // Get thread history if not provided
  let finalThreadLogs = threadLogs;
  if (!finalThreadLogs.length) {
    finalThreadLogs = await getThreadHistory.call(
      context,
      thread.extId, 
      { functionName: 'chatAgent', maxRetries: 10 }
    );
  }

  // Handle user input
  if (input) {
    finalThreadLogs.push({
      role: 'user',
      content: input,
    });
  }

  // Handle audio transcription if provided
  if (audio && capabilities.transcribe) {
    const transcribedText = await transcribeAudio(context, { 
      resources, 
      audio, 
      instructions, 
      agentType: 'transcriber',
      user,
      thread
    }, res).then(result => result.message);
    
    finalThreadLogs.push({
      role: 'user',
      content: transcribedText,
    });
  }

  // Create prompt with context
  const promptVariables = {
    copilotPrompt: createPrompt(copilotPromptTemplate, {
      name: copilotz?.name,
      backstory: copilotz?.backstory,
      jobRole: copilotz?.job?.role,
      jobGoal: copilotz?.job?.goal,
      jobDescription: copilotz?.job?.description,
    }),
    instructions,
    currentDatePrompt: createPrompt(currentDatePromptTemplate, {
      currentDate: new Date().toDateString(),
    }),
  };
  
  const fullPrompt = createPrompt(chatPromptTemplate, 
    promptVariables, 
    { removeUnusedVariables: true }
  );

  console.log('[chatWithAI] fullPrompt', fullPrompt);

  // Configure AI provider
  const providerConfig = config?.AI_CHAT_PROVIDER || { provider: 'openai' };
  const { provider, fallbackProvider, ...providerOptions } = providerConfig;
  
  // Create chat provider function
  const createChatProvider = async (providerName: string, isFallback = false) => {
    const chatProvider = await withHooks(await ai('chat', providerName));
    return chatProvider.bind({
      __requestId__,
      __tags__: {
        threadId: threadId,
        ...(isFallback && { isFallback: true })
      },
      config: {
        ...providerOptions,
        apiKey:
          config?.[`${providerName}_CREDENTIALS`]?.apiKey || 
          env?.[`${providerName}_CREDENTIALS_apiKey`],
      },
      env,
    });
  };

  // Create primary and fallback providers
  const aiChat = await createChatProvider(provider);
  let aiFallbackChat;
  if (fallbackProvider) {
    aiFallbackChat = await createChatProvider(fallbackProvider, true);
  }
  
  // Call the AI with fallback handling
  let tokens, assistantAnswer;
  try {
    ({ tokens, answer: assistantAnswer } = await aiChat(
      { instructions: fullPrompt, messages: finalThreadLogs, answer },
      config?.streamResponseBy === 'token' ? res.stream : () => {}
    ));
  } catch (error) {
    if (aiFallbackChat) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Primary AI provider (${provider}) failed: ${errorMessage}. Trying fallback provider (${fallbackProvider}).`);
      
      ({ tokens, answer: assistantAnswer } = await aiFallbackChat(
        { instructions: fullPrompt, messages: finalThreadLogs, answer },
        config?.streamResponseBy === 'token' ? res.stream : () => {}
      ));
    } else {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Primary AI provider (${provider}) failed: ${errorMessage}. No fallback provider available.`);
      throw error;
    }
  }

  // Ensure message is a string
  const message =
    typeof assistantAnswer === 'string'
      ? assistantAnswer
      : JSON.stringify(assistantAnswer);

  // Return response
  return {
    message,
    input,
    consumption: {
      type: 'tokens',
      value: tokens,
    },
    __tags__: {
      threadId: threadId,
    }
  };
}

/**
 * Function Call Agent - Handles function execution and integration
 */
async function handleFunctionCalls(
  context: AgentContext,
  params: BaseAgentParams,
  res: ResponseObject
): Promise<any> {
  const {
    extId,
    resources,
    threadLogs = [],
    outputSchema,
    actionModules = {},
    inputSchema,
    overrideBaseInputSchema,
    overrideBaseOutputSchema,
    instructions,
    input,
    audio,
    answer,
    user,
    thread,
    agentType = 'functionCall',
    options,
    iterations = 0,
    capabilities = {},
  } = params;

  const maxIter = 5; // Maximum iterations to prevent infinite loops
  
  // Setup actions
  let actions: Record<string, any> = {};
  
  // Extract context
  const { modules, utils, env, withHooks } = context;
  const { actionExecutor, agents } = modules;
  const { createPrompt, _, getThreadHistory, jsonSchemaToShortSchema, mergeSchemas } = utils;
  const { copilotz, config } = resources;

  // Handle schemas
  const baseInputSchema = overrideBaseInputSchema || _baseInputSchema;
  const baseOutputSchema = overrideBaseOutputSchema || _baseOutputSchema;
  const finalInputSchema = inputSchema ? mergeSchemas(baseInputSchema, inputSchema) : baseInputSchema;
  const finalOutputSchema = outputSchema ? mergeSchemas(baseOutputSchema, outputSchema) : baseOutputSchema;

  // Setup action modules and specs
  if (copilotz?.actions?.length) {
    // Execute and merge actions
    const actionsObj = (await Promise.all(
      copilotz.actions.map(async (_action) => {
        const action = await actionExecutor.bind({
          ...context,
          threadId: thread?.extId,
        })({
          specs: _action.spec,
          specType: _action.specType,
          module: _action.moduleUrl
        }, res);
        return action;
      })
    )).reduce((acc, obj) => {
      Object.assign(acc, obj);
      return acc;
    }, {});

    // Convert to dot notation
    actions = getDotNotationObject(actionsObj);
  }

  // Add callback function to action modules
  actionModules.callback = async (data: any) => {
    await sleep(1000);
    res.stream(`${JSON.stringify(data)}\n`);
  };
  actionModules.callback.spec = `(send callback to user): message<string> -> (callback sent successfully)`;

  // Merge custom action modules with system actions
  Object.keys(actionModules).forEach((actionModule) => {
    const action = actions[actionModule];
    if (action) {
      actions[actionModule] = (args: any) => actionModules[actionModule](args, action);
      Object.assign(actions[actionModule], action);
    } else {
      actions[actionModule] = actionModules[actionModule];
    }
  });

  // Create action specs string
  const actionSpecs = Object.entries(actions)
    .map(([name, action]) => {
      return `${name}${action.spec || ''}`;
    })
    .join('\n');

  // Create function call prompt
  const responseFormatText = responseFormatPromptTemplate(
    { outputSchema: finalOutputSchema, inputSchema: finalInputSchema }, 
    jsonSchemaToShortSchema
  );
  
  const functionsPrompt = createPrompt(functionCallPromptTemplate, {
    responseFormatPrompt: responseFormatText,
    instructions,
    functionCallsPrompt: createPrompt(functionCallsPromptTemplate, {
      availableFunctions: actionSpecs,
    }),
  });

  // Format input based on schema
  const formattedInput = input
    ? JSON.stringify(validate(jsonSchemaToShortSchema(finalInputSchema), { message: input }))
    : '';

  // Get thread logs if not provided
  let finalThreadLogs = threadLogs;
  if (!finalThreadLogs.length) {
    finalThreadLogs = await getThreadHistory.call(
      context,
      thread.extId, 
      { functionName: 'functionCall', maxRetries: 10 }
    );
  }

  // Call chat agent to generate response
  const chatAgentResponse = await chatWithAI(
    context,
    {
      threadLogs: finalThreadLogs,
      resources,
      answer,
      user,
      thread,
      options,
      input: formattedInput,
      audio,
      agentType,
      instructions: functionsPrompt,
      capabilities,
    },
    res
  );

  let functionAgentResponse: any = {};

  // Process chat response
  if (chatAgentResponse?.message) {
    let responseJson: any = { functions: [] };
    try {
      // Parse and validate response
      const unvalidatedResponseJson = JSON.parse(jsonrepair(chatAgentResponse.message));
      
      responseJson = validate(
        jsonSchemaToShortSchema(finalOutputSchema),
        unvalidatedResponseJson,
        {
          optional: false,
          path: '$',
        }
      );

      functionAgentResponse = {
        ...chatAgentResponse,
        ...responseJson,
        consumption: {
          type: 'actions',
          value: responseJson?.functions?.length || 0,
        },
      };

      // Stream response if configured to do so
      if (config?.streamResponseBy === 'turn') {
        res.stream(`${JSON.stringify(functionAgentResponse)}\n`);
      }
    } catch (err) {
      // Handle parsing errors
      let errorMessage = 'INVALID JSON, Trying again!';
      
      console.log('[functionCall] INVALID JSON, Trying again!', err, 'answer:', chatAgentResponse.message);
      
      if (typeof err === 'string') {
        errorMessage = err;
      } else if ((err as Error).message) {
        errorMessage = (err as Error).message;
      }
      
      throw {
        ...chatAgentResponse,
        ...responseJson,
        error: { code: 'INVALID_JSON', message: errorMessage },
      };
    }

    // Execute functions
    if (functionAgentResponse?.functions) {
      functionAgentResponse.functions = await Promise.all(
        functionAgentResponse.functions.map(async (func: any) => {
          func.startTime = new Date().getTime();
          if (!func.name) return null;

          const action = _.get(actions, func.name);
          if (!action) {
            func.status = 'failed';
            func.results = `Function ${func.name} not found. Please, check and try again`;
            return func;
          }

          func.status = 'pending';
          try {
            const actionResponse = await Promise.resolve(
              action({ ...func.args, _metadata: { user, thread, extId } })
            );
            
            if (typeof actionResponse === 'object' && actionResponse.__media__) {
              const { __media__, ...actionResult } = actionResponse;
              if (config?.streamResponseBy === 'turn' && __media__) {
                res.stream(`${JSON.stringify({ media: __media__ })}\n`);
              }
              func.results = actionResult;
            } else {
              func.results = actionResponse || { message: 'function call returned `undefined`' };
            }
            
            func.status = 'ok';
          } catch (err) {
            func.status = 'failed';
            func.results = { error: { code: 'FUNCTION_ERROR', ...(err as any)?.error } };
          }

          return func;
        })
      );

      // Remove null entries
      functionAgentResponse.functions = functionAgentResponse.functions.filter(Boolean);
    }
  }

  // Handle recursion for handling function results
  if (
    functionAgentResponse?.functions?.length && 
    iterations < maxIter &&
    (!Object.keys(actionModules)?.some(actionName => 
      functionAgentResponse.functions.map((func: any) => func.name).includes(actionName)) || 
      functionAgentResponse?.nextTurn === 'assistant' || 
      functionAgentResponse?.functions?.some((func: any) => func.name !== 'callback'))
  ) {
    const assistantMessage = JSON.stringify(
      validate(jsonSchemaToShortSchema(_baseOutputSchema), functionAgentResponse)
    );

    // Update thread logs for recursion
    if (!finalThreadLogs?.length) {
      finalThreadLogs.push({
        role: 'user',
        content: formattedInput,
      });
    }

    finalThreadLogs.push({
      role: 'assistant',
      content: assistantMessage,
    });

    // Recursively call function handler
    return handleFunctionCalls(
      context,
      {
        ...params,
        threadLogs: finalThreadLogs,
        iterations: iterations + 1,
      },
      res
    );
  }

  return functionAgentResponse;
}

/**
 * Task Manager Agent - Manages workflow tasks
 */
async function manageTask(
  context: AgentContext,
  params: BaseAgentParams,
  res: ResponseObject
): Promise<any> {
  const {
    resources,
    answer,
    threadLogs = [],
    instructions,
    input,
    audio,
    user,
    thread,
    options,
    iterations = 0,
    outputSchema,
    overrideBaseOutputSchema,
    agentType = 'taskManager',
    capabilities = {},
  } = params;

  const maxIter = 3; // Maximum iteration count
  
  // Setup state
  let currentStep: any;
  let workflow: any;
  let taskDoc: any;

  // Extract context and dependencies
  const { models, modules, utils, withHooks } = context;
  const { createPrompt, getThreadHistory, jsonSchemaToShortSchema, mergeSchemas } = utils;
  const { agents } = modules;
  const { copilotz, config } = resources;

  // Extract workflow information
  const { job } = copilotz || {};
  const { workflows: jobWorkflows } = job || {};
  const { workflows: copilotWorkflows } = copilotz || {};
  const allWorkflows = [...(jobWorkflows || []), ...(copilotWorkflows || [])].filter(Boolean);

  const { extId: externalId } = thread;

  // Handle schemas
  const baseOutputSchema = overrideBaseOutputSchema || _baseOutputSchema;
  const finalOutputSchema = outputSchema ? mergeSchemas(baseOutputSchema, outputSchema) : baseOutputSchema;

  // Find active task
  taskDoc = await models.tasks.findOne(
    { extId: externalId, status: 'active' },
    { sort: { updatedAt: -1 } }
  );

  // Define action modules
  const actionModules: ActionModules = {
    createTask: async (args) => {
      // Get workflow name
      const workflowName = args.workflowName;
      if (!workflowName) {
        throw new Error(`Error creating task: 'workflowName' arg is required, found: ${Object.keys(args).join(',')}`);
      }
      
      // Find workflow
      const selectedWorkflow = allWorkflows.find(
        (wf) => wf.name.toLowerCase() === workflowName.toLowerCase()
      );

      if (!selectedWorkflow) {
        throw new Error(`Workflow "${workflowName}" not found`);
      }

      // Create task
      const taskData = {
        name: selectedWorkflow.name,
        description: selectedWorkflow.description,
        context: { user, createdAt: new Date().toISOString() },
        extId: externalId,
        status: 'active',
        workflow: selectedWorkflow._id,
        currentStep: selectedWorkflow.firstStep,
      };
      
      const newTask = await models.tasks.create(taskData);
      return newTask;
    },
    
    submit: async (_args, onSubmit) => {
      const { _user, ...args } = _args;

      const updateTaskPayload: any = {};
      let status = 'completed';
      let results;

      try {
        results = onSubmit ? await onSubmit(args) : args;
      } catch (error) {
        status = 'failed';
        results = { error };
        console.error(`[taskManager] Error processing submit function:`, error);
      }

      // Handle step navigation
      if (status !== 'failed') {
        updateTaskPayload.currentStep = currentStep.next;
        if (!currentStep.next) {
          updateTaskPayload.status = 'completed';
        }
      } else {
        updateTaskPayload.status = 'failed';
        if (currentStep.failedNext) {
          updateTaskPayload.currentStep = currentStep.failedNext;
        }
      }

      // Update task context
      const updatedAt = new Date().toISOString();
      updateTaskPayload.context = {
        steps: {
          ...taskDoc?.context?.steps,
          [currentStep.name]: { args, results, updatedAt }
        },
        state: {
          ...taskDoc?.context?.state,
          ...results
        }
      };

      await models.tasks.update({ _id: taskDoc._id }, updateTaskPayload);
      return results;
    },
    
    changeStep: async ({ stepName }) => {
      const step = workflow.steps.find((step: any) => step.name === stepName);
      if (!step) {
        throw new Error(`Step "${stepName}" not found in workflow "${workflow.name}"`);
      }

      await models.tasks.update({ _id: taskDoc._id }, { currentStep: step._id });
      return { name: step.name, description: step.description, id: step._id };
    },
    
    cancelTask: async () => {
      await models.tasks.update({ _id: taskDoc._id }, { status: 'cancelled' });
      return { message: 'Task cancelled' };
    },
    
    setState: async ({ key, value }) => {
      await models.tasks.update(
        { _id: taskDoc._id }, 
        { context: { ...taskDoc.context, state: { ...taskDoc.context.state, [key]: value } } }
      );
      return { message: 'Context updated' };
    },
  };

  // Define action specifications
  const actionSpecs: Record<string, string> = {
    createTask: `(creates a new task for a given workflow): !workflowName<string>(name of the workflow to start)->(returns task object)`,
    changeStep: `(changes the current step of the working task in current workflow): !stepName<string>(name of the step to change to)->(returns string 'step changed')`,
    cancelTask: `(cancels the current task): ->(returns string 'task cancelled')`,
    setState: `(sets a value for a given key in the task state): !key<string>(key to set), !value<any>(value to set)->(returns string 'context updated')`,
    submit: `(submits current step): <any>(JSON object to be stored in task context for future references)->(returns step submission results)`,
  };

  // Assign specs to action modules
  Object.keys(actionModules).filter(Boolean).forEach((actionName) => {
    if (actionSpecs[actionName]) {
      actionModules[actionName].spec = actionSpecs[actionName];
    }
  });

  // Handle existing task
  let finalInstructions = instructions || '';
  if (taskDoc) {
    // Load workflow and current step
    workflow = await models.workflows.findOne({ _id: taskDoc.workflow }, { populate: ['steps'] });
    currentStep = await models.steps.findOne({ _id: taskDoc.currentStep }, { populate: ['actions'] });
    
    // Handle onSubmit function
    currentStep.onSubmit = currentStep?.onSubmit 
      ? await models.actions.findOne({ _id: currentStep.onSubmit }) 
      : null;
    
    // Load job context if needed
    if (currentStep?.job?._id && currentStep?.job?._id !== copilotz?.job?._id) {
      const job = await models.jobs.findOne({ _id: currentStep.job }, { populate: ['actions'] });
      if (copilotz) {
        copilotz.job = job;
      }
    }

    // Extract step details
    const {
      name: stepName,
      instructions: stepInstructions,
      submitWhen,
    } = currentStep;

    // Combine actions from different sources with uniqueness
    const uniqueActionsMap = new Map();
    [
      ...(copilotz?.actions || []),
      ...(copilotz?.job?.actions || []),
      ...(currentStep?.actions || []),
      (currentStep?.onSubmit || null),
    ]
      .filter(Boolean)
      .forEach(action => {
        uniqueActionsMap.set(action._id.toString(), action);
      });

    if (copilotz) {
      copilotz.actions = Array.from(uniqueActionsMap.values());
      resources.copilotz = copilotz;
    }

    // Create task prompt
    const taskManagerPrompt = createPrompt(currentTaskPromptTemplate, {
      workflow: workflow.name,
      workflowDescription: workflow.description,
      steps: workflow.steps.map((step: any, index: number) => `${index + 1}. ${step.name}`).join(';\n'),
      stepInstructions,
      stepName: `${workflow.steps.findIndex((step: any) => step._id === currentStep._id) + 1}. ${stepName}`,
      context: JSON.stringify(taskDoc?.context?.state),
      submitWhen,
    });

    finalInstructions = taskManagerPrompt + finalInstructions;
  } else {
    // No active task - provide workflow options
    const availableWorkflowsPrompt = createPrompt(availableWorkflowsTemplate, {
      workflows: allWorkflows.map((wf) => `- ${wf.name}: ${wf.description}`).join('\n'),
    });

    finalInstructions = availableWorkflowsPrompt + finalInstructions;
  }

  // Get thread logs if not provided
  let finalThreadLogs = threadLogs;
  if (!finalThreadLogs.length) {
    finalThreadLogs = await getThreadHistory.call(
      context, 
      thread.extId, 
      { functionName: 'taskManager', maxRetries: 10 }
    );
  }

  // Call function call agent to handle task
  return handleFunctionCalls(
    context,
    {
      resources,
      actionModules,
      instructions: finalInstructions,
      input,
      audio,
      user,
      thread,
      answer,
      options,
      threadLogs: finalThreadLogs,
      agentType,
      outputSchema: finalOutputSchema,
      capabilities,
    },
    res
  );
}

/**
 * Main unified agent that intelligently determines functionality based on context
 * 
 * Decides which specialized functionality to use based on:
 * - If resources have workflow property → use task management
 * - If resources have actions property → use the function calling logic
 * - If capabilities.transcribe === true → use audio transcription (when audio is provided)
 * - Otherwise, falls back to standard chat functionality
 */
async function unifiedAgent(
  this: AgentContext,
  params: BaseAgentParams,
  res: ResponseObject
): Promise<any> {
  const context = this;
  const { 
    resources, 
    capabilities = {}, 
    audio,
    agentType // Kept for backward compatibility
  } = params;
  const { copilotz } = resources;

  try {
    console.log(`[unifiedAgent] Starting intelligent agent`);
    
    // Determine which agent functionality to use based on context
    
    // 1. Handle audio transcription if audio is provided and transcription is enabled
    if (audio && (capabilities.transcribe || agentType === 'transcriber')) {
      console.log('[unifiedAgent] Audio detected, using transcription functionality');
      return await transcribeAudio(context, params, res);
    }
    
    // 2. Check for task management (workflows)
    if (copilotz?.workflows?.length || copilotz?.job?.workflows?.length || agentType === 'taskManager') {
      console.log('[unifiedAgent] Workflows detected, using task management functionality');
      return await manageTask(context, params, res);
    }
    
    // 3. Check for function calling (actions)
    if (copilotz?.actions?.length || agentType === 'functionCall') {
      console.log('[unifiedAgent] Actions detected, using function call functionality');
      return await handleFunctionCalls(context, params, res);
    }
    
    // 4. Default to chat functionality
    console.log('[unifiedAgent] Using standard chat functionality');
    return await chatWithAI(context, params, res);
  } catch (error) {
    console.error(`[unifiedAgent] Error in agent:`, error);
    throw {
      message: `Error in agent: ${(error as Error).message || JSON.stringify(error)}`,
      status: (error as any).status || 500,
    };
  }
}

// ========================================================================================
// EXPORT
// ========================================================================================

/**
 * Utility function to bind getThreadHistory to the correct context
 */
async function getThreadHistory(
  this: AgentContext,
  threadId: string, 
  { functionName, maxRetries = 10, toAppend = null }: { functionName: string; maxRetries?: number; toAppend?: any }
): Promise<LogEntry[]> {
  const { models } = this;

  // Find logs for this thread
  const logs = (await models.logs.find({
    "name": functionName,
    "tags.threadId": threadId,
    "status": "completed",
    "hidden": null,
  }, { sort: { createdAt: -1 }, limit: 50 }))
    .map((log: any) => log.output)
    .filter(Boolean) || [];

  const messageLogs: LogEntry[] = [];
  
  logs.forEach((log: any) => {
    const { input, ...output } = log;

    const answer: LogEntry = {
      role: 'assistant',
      content: (output && typeof output === 'string') ? output : JSON.stringify(output)
    };

    // first log is the answer (it'll be reversed)
    if (output) messageLogs.push(answer);

    const tryParseInput = (input: any) => {
      try {
        return JSON.parse(input);
      } catch (e) {
        return input;
      }
    };

    if (['functionCall', 'taskManager'].indexOf(functionName) !== -1) {
      if (!input || (typeof input === 'string' && !tryParseInput(input))) {
        return;
      }
    }

    const question: LogEntry = {
      role: 'user',
      content: (input && typeof input === 'string') ? input : JSON.stringify(input)
    };
    
    if (input) messageLogs.push(question);
  });

  return messageLogs.reverse();
}

// Export the main agent and utilities
export default unifiedAgent;

// Export individual agents for direct use if needed
export {
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
  base64ToBlob,
}; 