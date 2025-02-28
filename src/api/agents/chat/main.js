// chat/main.js
import validate from "axion-modules/connectors/validator.ts";

/**
 * Main function for the chat agent.
 *
 * @param {Object} params - Function parameters.
 * @param {string} params.instructions - Instructions for the agent.
 * @param {string|Array<Object>} params.input - User input, can be a string or an array of objects.
 * @param {string} params.input[].type - Type of the input, can be 'text' or 'image_url'.
 * @param {string} [params.input[].text] - Text input, required if type is 'text'.
 * @param {Object} [params.input[].image_url] - Image URL input, required if type is 'image_url'.
 * @param {string} params.input[].image_url.url - URL of the image, can be a regular URL or a base64 encoded image.
 * @param {string} params.input[].image_url.detail - Detail about the image.
 * @param {Object} params.user - User information.
 * @param {Object} params.thread - Thread information.
 * @param {Object} res - Response object.
 * @param {Object} config - Configuration object.
 * @param {Object} config.AI_CHAT_PROVIDER - AI chat provider configuration.
 * @param {string} config.AI_CHAT_PROVIDER.provider - Provider name, e.g., 'openai'.
 * @param {Object} config.AI_CHAT_PROVIDER.options - Additional options for the provider.
 * @param {Object} env - Environment variables.
 * @param {string} env.OPENAI_CREDENTIALS_apiKey - API key for OpenAI.
 * @param {string} env.OTHER_PROVIDER_CREDENTIALS_apiKey - API key for another provider.
 * @returns {Promise<Object>} - Returns a Promise that resolves with the response object.
 */

async function chatAgent(
    {
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
        threadLogs,
        answer,
        agentType,
        options,
    },
    res
) {
    agentType = agentType || 'chat';

    // 1. Extract Modules, Resources, Utils, and Dependencies
    const {
        __tags__,
        __requestId__,
        __executionId__,
        withHooks,
        modules,
        utils,
        env,
    } = this || chatAgent;

    // 1.1 Extract Utils
    const { createPrompt, getThreadHistory } = utils;

    // 1.2 Extract Dependencies
    const { ai, agents } = modules;

    // 1.3 Extract Resources
    const { copilotz, config } = resources;

    // 1.3 Override Base Schemas
    const baseInputSchema = overrideBaseInputSchema || _baseInputSchema;
    const baseOutputSchema = overrideBaseOutputSchema || _baseOutputSchema;

    // 1.4. Extract and Merge Schemas
    inputSchema = inputSchema ? mergeSchemas(baseInputSchema, inputSchema) : baseInputSchema;
    outputSchema = outputSchema ? mergeSchemas(baseOutputSchema, outputSchema) : baseOutputSchema;

    // 2. Extract params
    // 2.1 Get Thread and Turn Ids;
    if (__tags__ && !__tags__?.turnId) __tags__.turnId = __executionId__;
    const { extId: threadId } = thread;

    // 3. Get Thread Logs

    if (!threadLogs || !threadLogs?.length) {
        threadLogs = await getThreadHistory(thread.extId, { functionName: 'chatAgent', maxRetries: 10 })
    }

    // 4. Process User Input
    // 4.1. If User Input Exists, Add to Chat Logs
    if (input) {
        threadLogs.push({
            role: 'user',
            content: input,
        });
    }

    // 4.2. If Audio Exists, Transcribe to Text and Add to Chat Logs
    if (audio) {
        const transcriber = await withHooks(await agents('transcriber'));
        const { message: transcribedText } = await transcriber.bind(this)({
            audio,
            instructions,
            agentType,
        });
        const transcribedMessage = {
            role: 'user',
            content: transcribedText,
        };
        threadLogs.push(transcribedMessage);
    }

    // 5. Create Prompt
    // 5.1 Create Prompt Variables
    const promptVariables = {
        copilotPrompt: createPrompt(copilotPromptTemplate, {
            name: copilotz.name,
            backstory: copilotz.backstory,
            jobRole: copilotz.job?.role,
            jobGoal: copilotz.job?.goal,
            jobDescription: copilotz.job?.description,
        }),
        instructions,
        currentDatePrompt: createPrompt(currentDatePromptTemplate, {
            currentDate: new Date(),
        }),
    };
    // 5.2 Create Prompt Instructions
    const fullPrompt = createPrompt(instructions || promptTemplate, promptVariables, { removeUnusedVariables: true });

    // 6. Get AI Chat
    const { provider, fallbackProvider, ...providerOptions } = config?.AI_CHAT_PROVIDER || {
        provider: 'openai',
    }; // use openai as default provider
    
    // Function to create a bound chat provider
    const createChatProvider = async (providerName, isFallback = false) => {
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
                    config?.[`${providerName}_CREDENTIALS`]?.apiKey || // check for custom credentials in config
                    env?.[`${providerName}_CREDENTIALS_apiKey`], // use default credentials from env
            },
            env,
        });
    };

    // Create primary chat provider
    const aiChat = await createChatProvider(provider);
    
    // Create fallback chat provider if configured
    let aiFallbackChat;
    if (fallbackProvider) {
        aiFallbackChat = await createChatProvider(fallbackProvider, true);
    }
    // 7. Execute AI Chat
    let tokens, assistantAnswer;
    try {
        ({ tokens, answer: assistantAnswer } = await aiChat(
            { instructions: fullPrompt, messages: threadLogs, answer },
            config.streamResponseBy === 'token' ? res.stream : () => { }
        ));
    } catch (error) {
        // If primary provider fails and fallback is available, try the fallback
        if (aiFallbackChat) {
            console.warn(`Primary AI provider (${provider}) failed: ${error.message}. Trying fallback provider (${fallbackProvider}).`);
            ({ tokens, answer: assistantAnswer } = await aiFallbackChat(
                { instructions: fullPrompt, messages: threadLogs, answer },
                config.streamResponseBy === 'token' ? res.stream : () => { }
            ));
        } else {
            console.error(`Primary AI provider (${provider}) failed: ${error.message}. No fallback provider (${fallbackProvider}) available.`);
            // If no fallback is available, rethrow the error
            throw error;
        }
    }

    // 8. Prepare Response
    // Ensure 'message' is a string
    const message =
        typeof assistantAnswer === 'string'
            ? assistantAnswer
            : JSON.stringify(assistantAnswer);

    // 9. Construct Response Object
    const response = {
        message,
        input: input,
        consumption: {
            type: 'tokens',
            value: tokens,
        },
        __tags__: {
            threadId: threadId,
        }
    };

    // 10. Return Response
    return response;
};

export default chatAgent;

const promptTemplate = `
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


const _baseInputSchema = {
    type: 'object',
    properties: {
        instructions: {
            type: 'string',
        },
        input: {
            type: 'string',
        },
    },
};

const _baseOutputSchema = {
    type: 'object',
    properties: {
        prompt: {
            type: 'string',
        },
        message: {
            type: 'string',
        },
        consumption: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                },
                value: {
                    type: 'number',
                },
            },
        },
    },
};