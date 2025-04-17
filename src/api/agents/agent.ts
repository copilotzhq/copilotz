// unified-agent.ts
// Consolidated agent module that combines taskManager, functionCall, chat, and transcriber
// ========================================================================================

import { jsonrepair } from "npm:jsonrepair";
import { getDotNotationObject } from "axion-modules/connectors/validator.ts";
import lodash from "npm:lodash";
import { validate } from '../actions/v2/jsonSchemaValidator.ts';
import { jsonSchemaToFunctionSpec } from '../actions/v2/main.ts';

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
    actionHandler: (actions: any) => Promise<any>;
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

- The functions specs are defined as follow:

$function_name_1($function_description):$arg_name_1<$arg_type_1>($arg_description_1), $arg_name_2<$arg_type_2>($arg_description_2), ... $arg_name_n<$arg_type_n>($arg_description_n) -> ($return_property_1<$return_type_1>($return_description_1), $return_property_2<$return_type_2>($return_description_2), ... $return_property_n<$return_type_n>($return_description_n))

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
    },
  },
  additionalProperties: true,
  required: ['message']
};

const _baseOutputSchema = {
  type: 'object',
  properties: {
    // think: {
    //   type: 'string',
    //   description: 'answer in 1 sentence each question: 1. what is the most important instruction to follow? what information from the conversation should I consider? 3. what are the results from function calls I need to consider? 4. what do I send the user and which function (if any) should I call?'
    // },
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
          },
          results: {
            type: 'object',
            description: 'The results of the function call. Leave empty as it will be filled by the function call'
          },
          status: {
            type: 'string',
            description: 'The status of the function call. Leave empty as it will be filled by the function call'
          }
        },
        required: ['name', 'args']
      },
      description: 'The functions to call'
    },
    media: {
      type: 'object',
      description: 'The media to send to the user. (leave empty if no media is needed)'
    },
    nextTurn: {
      type: 'string',
      enum: ['user', 'assistant'],
      description: 'Set to `assistant` if the assistant should continue in the same turn without waiting for the user to respond (leave empty if no follow up is needed)'
    },
    usage: {
      type: 'object',
      properties: {
        tokens: { type: 'number' },
        actions: { type: 'number' },
      },
      additionalProperties: true,
    },
    additionalProperties: true,
  },
  required: [
    'message'
    // 'think'
  ]
};

export function responseFormatPromptTemplate({ outputSchema, inputSchema }: { outputSchema: any, inputSchema: any }, shortSchemaFn: Function): string {
  return `
## RESPONSE FORMAT

Your response must follow the following json-schema:
\`\`\`json
${JSON.stringify(outputSchema)}
\`\`\`

User input format:
\`\`\`json
${JSON.stringify(inputSchema)}
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
): Promise<{ message: string; prompt?: any; usage?: any }> {
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
    usage: {
      hours: transcribedAudio.duration,
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
): Promise<{ message: string; input?: string; usage?: Record<string, any>; __tags__?: any }> {
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
  const { createPrompt } = utils;
  const { ai } = modules;
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
      { functionName: 'agent', maxRetries: 10 }
    );
    // Handle user input
  }

  if (input) {
    finalThreadLogs.push({
      role: 'user',
      content: input,
    });
  }

  // Handle audio transcription if provided
  let transcribeUsage: any;
  if (audio && capabilities.transcribe) {
    const { message: transcribedText, usage: _usage } = await transcribeAudio(context, {
      resources,
      audio,
      instructions,
      agentType: 'transcriber',
      user,
      thread
    }, res);

    transcribeUsage = _usage;

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
      config?.streamResponseBy === 'token' ? res.stream : () => { }
    ));
  } catch (error) {
    if (aiFallbackChat) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Primary AI provider (${provider}) failed: ${errorMessage}. Trying fallback provider (${fallbackProvider}).`);

      ({ tokens, answer: assistantAnswer } = await aiFallbackChat(
        { instructions: fullPrompt, messages: finalThreadLogs, answer },
        config?.streamResponseBy === 'token' ? res.stream : () => { }
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
    usage: {
      ...(transcribeUsage || {}),
      tokens,
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
): Promise<{ message: string; input?: string; usage?: Record<string, any>; __tags__?: any, functions?: any[], nextTurn?: string }> {
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
  const { actionHandler } = modules;
  const { createPrompt, _, jsonSchemaToShortSchema, mergeSchemas } = utils;
  const { copilotz, config } = resources;

  // Handle schemas
  const baseInputSchema = overrideBaseInputSchema || _baseInputSchema;
  const baseOutputSchema = overrideBaseOutputSchema || _baseOutputSchema;
  const finalInputSchema = inputSchema ? mergeSchemas(baseInputSchema, inputSchema) : baseInputSchema;
  const finalOutputSchema = outputSchema ? mergeSchemas(baseOutputSchema, outputSchema) : baseOutputSchema;

  // Setup action modules and specs using the new action system
  if (copilotz?.actions?.length) {
    // Process actions using our new action handler
    try {
      // Actions will be a map of functionName -> handler
      // The handler function will have .spec property for the prompt
      actions = await actionHandler.bind({
        ...context,
        threadId: thread?.extId,
      })(copilotz.actions);

    } catch (error) {
      console.error('Error processing actions:', error);
    }
  }

  // Add callback function to actions
  actions.callback = async (data: any) => {
    await sleep(1000);
    res.stream(`${JSON.stringify(data)}\n`);
  };
  actions.callback.spec = `(send callback to user): message<string> -> (callback sent successfully)`;

  // Merge custom action modules with system actions
  Object.keys(actionModules).forEach((actionModule) => {
    const action = actions[actionModule];
    if (action) {
      actions[actionModule] = (args: any) => actionModules[actionModule](args, action);
      // Preserve spec from original action
      if (action.spec) {
        actions[actionModule].spec = action.spec;
      }
    } else {
      actions[actionModule] = actionModules[actionModule];
    }
  });

  // Create action specs string directly from JSON schemas via our converter
  const actionSpecs = Object.entries(actions)
    .map(([name, action]) => {
      // Use action.spec if available, otherwise generate from schema
      let spec = '';

      if (action.spec) {
        spec = action.spec;
      } else if (action.inputSchema && action.outputSchema) {
        spec = `(${action.description || name}): ${jsonSchemaToFunctionSpec(action.inputSchema, '', action.outputSchema)}`;
      }

      return spec ? `${name}${spec}` : name;
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

  // Format input based on schema using JSON Schema validation
  const formattedInput = input
    ? JSON.stringify(validate(finalInputSchema, { message: input }))
    : '';

  // Get thread logs if not provided
  let finalThreadLogs = threadLogs;
  if (!finalThreadLogs.length) {
    finalThreadLogs = await getThreadHistory.call(
      context,
      thread.extId,
      { functionName: 'agent', maxRetries: 10 }
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
      // Parse and validate response using JSON Schema directly
      const unvalidatedResponseJson = JSON.parse(jsonrepair(chatAgentResponse.message));

      responseJson = validate(
        finalOutputSchema,
        unvalidatedResponseJson
      );

      functionAgentResponse = {
        ...chatAgentResponse,
        ...responseJson,
        usage: {
          ...chatAgentResponse.usage,
          actions: responseJson?.functions?.length || 0,
        },
      };

      // Stream response if configured to do so
      if (config?.streamResponseBy === 'turn') {
        res.stream(`${JSON.stringify(functionAgentResponse)}\n`);
      }
    } catch (err) {
      // Handle parsing errors
      let errorMessage = 'INVALID JSON, Trying again!';
      if (err instanceof Error) {
        errorMessage = `Error: ${err.message}`;
      }
      // res.stream(errorMessage);

      // Retry if iterations are under limit
      if (iterations < maxIter) {
        const iterResponse = await handleFunctionCalls(
          context,
          {
            ...params,
            iterations: iterations + 1,
            input: JSON.stringify({ warning: errorMessage, previousAnswer: chatAgentResponse.message }),
          },
          res
        );

        return iterResponse;
      }

      return {
        message: errorMessage,
        functions: [],
      };
    }

    // Execute functions
    try {
      if (responseJson.functions && responseJson.functions.length > 0) {
        // Execute each function in sequence
        for (const functionCall of responseJson.functions) {
          // Skip if already executed or no name
          if (functionCall.status === 'pending' || !functionCall.name) continue;

          // Mark as executing
          functionCall.startTime = Date.now();

          try {
            // Get function from actions
            const fn = actions[functionCall.name];


            if (typeof fn === 'function') {
              // Execute function with args
              const _metadata = {
                user,
                thread,
              };
              const result = await fn({ ...functionCall.args, _metadata });

              if (typeof result === 'object' && result.__media__) {
                const { __media__, ...actionResult } = result;
                if (config?.streamResponseBy === 'turn' && __media__) {
                  res.stream(`${JSON.stringify({ media: __media__ })}\n`);
                }
                functionCall.results = actionResult;
              } else {
                // Store result
                functionCall.results = result;
                functionCall.status = 'ok';
              }

            } else {
              throw new Error(`Function '${functionCall.name}' not found`);
            }
          } catch (fnErr) {
            // Handle function execution error
            // console.error(`Error executing function '${functionCall.name}':`, fnErr);
            functionCall.status = 'failed';
            functionCall.error = fnErr instanceof Error ? fnErr.message : fnErr;
            console.log('Function error:', functionCall.error);
          }

          // Calculate duration
          functionCall.duration = Date.now() - (functionCall.startTime || 0);

        }

        // Handle recursion for AI follow-up on function results
        const needsFollowup = responseJson.nextTurn === 'assistant' ||
          responseJson?.functions?.length > 0;

        if (needsFollowup && iterations < maxIter) {
          // Add previous interaction to thread logs if needed
          const updatedThreadLogs = [...finalThreadLogs];

          // Add user input if not already there
          if (input && !updatedThreadLogs.some(log =>
            log.role === 'user' && log.content === input)) {
            updatedThreadLogs.push({
              role: 'user',
              content: input,
            });
          }

          // Add the updated assistant message with function results included in the functions array
          updatedThreadLogs.push({
            role: 'assistant',
            content: JSON.stringify(responseJson),
          });

          // Make recursive call with updated logs
          await context.withHooks(agent).bind(context)(
            {
              ...params,
              input: '',
              threadLogs: updatedThreadLogs,
              iterations: iterations + 1,
            },
            res
          );
        }
      }
    } catch (execErr) {
      console.error('Error executing functions:', execErr);
    }
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
  const { createPrompt, jsonSchemaToShortSchema, mergeSchemas } = utils;
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
      { functionName: 'agent', maxRetries: 10 }
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
async function agent(
  this: AgentContext,
  params: BaseAgentParams,
  res: ResponseObject
): Promise<any> {

  const context = { ...this };

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
    if (copilotz?.job?.workflows?.filter(Boolean)?.length || agentType === 'taskManager') {
      console.log('[unifiedAgent] Workflows detected, using task management functionality');
      return await manageTask(context, params, res);
    }

    // 3. Check for function calling (actions)
    if (copilotz?.actions?.filter(Boolean)?.length || agentType === 'functionCall') {
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
  const { rows } = (await models.logs.customQuery(`SELECT * FROM logs WHERE name = '${functionName}' AND json_extract(tags, '$.threadId') = '${threadId}' AND status = 'completed' AND hidden IS NULL ORDER BY createdAt DESC LIMIT 50`))

  const messageLogs: LogEntry[] = [];

  rows.forEach((row: any) => {

    const log = tryParseInput(row.output);

    const { input, ...output } = log;

    const answer: LogEntry = {
      role: 'assistant',
      content: (output && typeof output === 'string') ? output : JSON.stringify(output)
    };

    // first log is the answer (it'll be reversed)
    if (output) messageLogs.push(answer);


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

const tryParseInput = (input: any) => {
  try {
    return JSON.parse(input);
  } catch (e) {
    return input;
  }
}

// Export the main agent and utilities
export default agent;

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