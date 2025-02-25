// functionCall.main.js

import { jsonrepair } from "npm:jsonrepair";
import validate, { getDotNotationObject } from "axion-modules/connectors/validator.ts";

// Define Configs
const maxIter = 5;

async function functionCall(
  {
    extId,
    resources,
    threadLogs,
    outputSchema,
    actionModules,
    inputSchema,
    overrideBaseInputSchema,
    overrideBaseOutputSchema,
    instructions,
    input,
    audio,
    answer,
    user,
    thread,
    agentType,
    options,
    iterations = 0,
  },
  res
) {
  agentType = agentType || 'functionCall';

  let actions = {};
  actionModules = actionModules || {};

  // 1. Extract Modules, Resources, Utils, and Dependencies
  const { modules, utils, env, withHooks } = this || functionCall;

  const { actionExecutor, agents } = modules;

  // 1.1 Extract Utils
  const { createPrompt, _, getThreadHistory, jsonSchemaToShortSchema, mergeSchemas } = utils;

  // 1.2 Extract Resources
  const { copilotz, config } = resources;

  // 1.3 Override Base Schemas
  const baseInputSchema = overrideBaseInputSchema || _baseInputSchema;
  const baseOutputSchema = overrideBaseOutputSchema || _baseOutputSchema;

  // 1.4. Extract and Merge Schemas
  inputSchema = inputSchema ? mergeSchemas(baseInputSchema, inputSchema) : baseInputSchema;
  outputSchema = outputSchema ? mergeSchemas(baseOutputSchema, outputSchema) : baseOutputSchema;

  // 2. Define Function Call Methods and Specs
  if (copilotz?.actions?.length) {

    // 2.1. Execute actions
    const actionsObj = (await Promise.all(
      copilotz.actions.map(async (_action) => {
        const action = await actionExecutor.bind({
          ...this,
          threadId: thread?.extId,
        })({
          specs: _action.spec,
          specType: _action.specType,
          module: _action.moduleUrl
        }, res)
        return action;
      })
    )) // 2.2. Merge actions
      .reduce((acc, obj) => {
        Object.assign(acc, obj);
        return acc;
      }, {})

    // 2.2. Expand and merge to dot notation;
    actions = getDotNotationObject(actionsObj);
  }

  // 2.8. If inherited actionModules, run actions with the same name through actionModules as hooks
  // 2.8.1. Append callback to actionModules
  actionModules.callback = async (data) => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    res.stream(`${JSON.stringify(data)}\n`)
  };
  actionModules.callback.spec = `(send callback to user): message<string> -> (callback sent successfully)`

  Object.keys(actionModules).forEach((actionModule) => {
    const action = actions[actionModule];
    if (action) {
      actions[actionModule] = (args) => actionModules[actionModule](args, action)
      Object.assign(actions[actionModule], action)
    }
    else {
      actions[actionModule] = actionModules[actionModule]
    }
  });


  // 3. Get Action Specs
  const actionSpecs = Object.entries(actions)
    .map(([name, action]) => {
      return `${name}${action.spec}`;
    })
    .join('\n');

  // 4. Create Prompt
  const functionsPrompt = createPrompt(instructions || promptTemplate, {
    responseFormatPrompt: createPrompt(
      responseFormatPromptTemplate({ outputSchema, inputSchema }, jsonSchemaToShortSchema),
      {}
    ),
    functionCallsPrompt: createPrompt(functionCallsPromptTemplate, {
      availableFunctions: actionSpecs,
    }),
  });

  // 5. Validate and Format Input
  const formattedInput = input
    ? JSON.stringify(validate(jsonSchemaToShortSchema(inputSchema), { message: input }))
    : '';

  // 6. Get Thread Logs
  if (!threadLogs || !threadLogs?.length) {
    threadLogs = await getThreadHistory(thread.extId, { functionName: 'functionCall', maxRetries: 10 })
  }

  // 7. Call Chat Agent
  const chatAgent = await withHooks(await agents('chat'));

  const chatAgentResponse = await chatAgent.bind(this)(
    {
      threadLogs,
      resources,
      answer,
      user,
      thread,
      options,
      input: formattedInput,
      audio,
      agentType,
      instructions: functionsPrompt,
    },
    res
  );

  let functionAgentResponse = {};


  // 8. Validate and Format Output
  if (chatAgentResponse?.message) {
    let responseJson = {};
    try {
      const unvalidatedResponseJson = JSON.parse(jsonrepair(chatAgentResponse.message));

      responseJson = validate(
        jsonSchemaToShortSchema(outputSchema),
        unvalidatedResponseJson,
        {
          optional: false,
          path: '$',
          rejectExtraProperties: false,
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

      config.streamResponseBy === 'turn' && res.stream(`${JSON.stringify(functionAgentResponse)}\n`);
    } catch (err) {
      let errorMessage;
      responseJson.functions = [];
      console.log('[functionCall] INVALID JSON, Trying again!', err, 'answer:', chatAgentResponse.message);
      if (typeof err === 'string') {
        errorMessage = err;
      } else if (err.message) {
        errorMessage = err.message;
      } else {
        errorMessage = 'INVALID JSON, Trying again!';
      }
      throw {
        ...chatAgentResponse,
        ...responseJson,
        error: { code: 'INVALID_JSON', message: errorMessage },
      };
    }

    // 9. Execute Functions
    if (functionAgentResponse?.functions) {
      functionAgentResponse.functions = await Promise.all(
        functionAgentResponse.functions.map(async (func) => {
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
            const actionResponse = await Promise.resolve(action({ ...func.args, _metadata: { user, thread, extId } }));
            if (typeof actionResponse === 'object' && actionResponse.__media__) {
              const { __media__, ...actionResult } = actionResponse;
              if (config.streamResponseBy === 'turn' && __media__) {
                res.stream(`${JSON.stringify({ media: __media__ })}\n`);
              }
              func.results = actionResult;
            } else {
              func.results = actionResponse || { message: 'function call returned `undefined`' };
            }
            func.status = 'ok';
          } catch (err) {
            func.status = 'failed';
            func.results = { error: { code: 'FUNCTION_ERROR', ...err?.error } };
          }

          return func;
        })
      );

      // Remove null entries (functions without names)
      functionAgentResponse.functions = functionAgentResponse.functions.filter(Boolean);
    }
  }

  // 10. Recursion Handling
  if (functionAgentResponse?.functions?.length && iterations < maxIter) {
    if (!Object.keys(actionModules)?.some(actionName => functionAgentResponse.functions.map(func => func.name).includes(actionName))) {
      if (functionAgentResponse?.nextTurn === 'assistant' || functionAgentResponse?.functions?.length) {

        const assistantMessage = JSON.stringify(
          validate(jsonSchemaToShortSchema(_baseOutputSchema), functionAgentResponse)
        );

        // Update threadLogs for recursion, including only relevant properties
        if (!threadLogs?.length) {
          threadLogs.push({
            role: 'user',
            content: formattedInput,
          });
        }

        threadLogs.push({
          role: 'assistant',
          content: assistantMessage,
        });

        await withHooks(functionCall).bind(this)(
          {
            resources,
            input: '',
            actionModules,
            user,
            thread,
            threadLogs,
            instructions,
            options,
            iterations: iterations + 1,
            agentType,
          },
          res
        )
      }
    }
  }
  // 11. Return Response
  return {
    ...functionAgentResponse,
    input: formattedInput,
    __tags__: {
      threadId: thread.extId,
    }
  };
};

export default functionCall;

const promptTemplate = `
{{copilotPrompt}}
================
{{functionCallsPrompt}}
================
{{responseFormatPrompt}}
================
{{currentDatePrompt}}
================
`;

const functionCallsPromptTemplate = `
## FUNCTION CALLS

You have the following functions you can call:

<availableFunctions>
{{availableFunctions}}
</availableFunctions>

Guidelines:
- Function definitions are formatted as:
  \`function_name(function_description): arg_1<type>(description), arg_2<type>(description), ..., arg_n<type>(description)->(response_description), response_param_1<type>(description), response_param_2<type>(description), ..., response_param_n<type>(description)\`
- "!" before "arg_" is only to inform you that the argument is required, otherwise, they're optional. Do not include "!" in your function call.
- Do not attempt to call functions that are not listed here. If there are no functions listed, do not call any functions.
`;

const responseFormatPromptTemplate = ({ outputSchema, inputSchema }, jsonSchemaToShortSchema) => `
## FORMATTING

User Input Format:
${JSON.stringify(jsonSchemaToShortSchema(inputSchema, { detailed: true }))}

Assistant Response Format:
${JSON.stringify(jsonSchemaToShortSchema(outputSchema, { detailed: true }))}

Guidelines:
- Valid JSON format is expected in both User Input and Assistant Response. Boolean values should be either \`true\` or \`false\` (not to be confused with string format \`"true"\` and \`"false"\`).
- Only the <message> content is visible to the user. Therefore, include all necessary information in the message.
- Parallel functions can be run by adding them to the functions array.
- Look back in your previous message to see the results of your last function calls. 
- If a function fails, diagnose if there's any error in the args you've passed. If so, retry. If not, provide a clear message to the user.
- Specify function names and arguments clearly.
- If you are asking the user for more information or waiting for a user response, set nextTurn to "user". If you have a clear answer, set nextTurn to "assistant".
- You must NOT include the function result in the functions array, just the function name and arguments.
`;

const _baseOutputSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "Assistant message goes here. This is what the user will see. Unless otherwise specified, leave it blank when calling a function.",
    },
    "media": {
      "type": "object",
      "description": "Media to be forwarded to the user. Leave it blank.",
    },
    "nextTurn": {
      'type': 'string',
      'description': `Enum ['user', 'assistant']. Who is expected to send the next message.`
    },
    "functions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "Function name",
          },
          "args": {
            "type": "object",
            "description": `JSON object (not stringified!) with the function arguments. Ex.: {"arg_name": "arg_value", "arg_name_2": "arg_value_2", ...}`,
          },
          "results": {
            "type": "any",
            "description": "Set as `null`. Will be filled with function result",
          },
          "status": {
            "type": "string",
            "description": "Set as `null`. Will be filled with function result status",
          },
        },
        "required": ["name"],
      },
      "description": "List of functions",
    },
  },
  "required": ["functions", "message", "nextTurn"],
};


const _baseInputSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "User message goes here"
    },
  },
  "required": ["message"]
}
