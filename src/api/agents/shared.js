import lodash from "npm:lodash";


function jsonSchemaToShortSchema(jsonSchema, { detailed } = {}) {

  detailed = detailed ?? false;

  function convertType(type) {
    switch (type) {
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'object':
        return 'object';
      case 'array':
        return 'array';
      case 'null':
        return 'null';
      default:
        return 'any';
    }
  }

  function formatProperties(properties, required = []) {
    const result = {};
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

function mergeSchemas(schema1, schema2) {
  // Função auxiliar para mesclar propriedades
  function mergeProperties(prop1, prop2) {
    const merged = { ...prop1, ...prop2 };
    if (Array.isArray(prop1) && Array.isArray(prop2)) {
      return mergeArrays(prop1, prop2);
    } else if (prop1.properties && prop2.properties) {
      merged.properties = mergeSchemas(prop1.properties, prop2.properties);
    }
    return merged;
  }

  // Função auxiliar para mesclar arrays sem duplicatas
  function mergeArrays(arr1, arr2) {
    return Array.from(new Set([...(arr1 || []), ...(arr2 || [])]));
  }

  // Mesclar as propriedades principais dos schemas
  const mergedSchema = {
    ...schema1,
    ...schema2,
    properties: {
      ...schema1.properties,
      ...schema2.properties
    },
    required: mergeArrays(schema1.required, schema2.required)
  };

  // Mesclar propriedades individuais
  for (const key in schema1.properties) {
    if (schema2.properties[key]) {
      mergedSchema.properties[key] = mergeProperties(schema1.properties[key], schema2.properties[key]);
    }
  }

  return mergedSchema;
}


function createPrompt(template, data, options = { removeUnusedVariables: false }) {
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

const mentionsExtractor = ({ input }) => {
  // Regex matches mentions that:
  // - Do not have a word character or dot before them
  // - Start with @ followed by one or more word characters, optionally followed by dots or hyphens
  // - Do not end with a dot, ensuring the mention is properly captured
  const mentionRegex = /(?<![\w.])@\w[\w-]*(?<!\.)/g;

  const mentions = input.match(mentionRegex);

  return mentions;
}


const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getThreadHistory(threadId, { functionName, maxRetries, toAppend }) {

  const { models } = this;

  maxRetries = maxRetries || 10;

  // 1.1. If Last Log Exists, Add to Chat Logs
  const logs = (await models.logs.find({
    "name": functionName,
    "tags.threadId": threadId,
    "status": "completed",
    "hidden": null,
  }, { sort: { createdAt: -1 }, limit: 50 }))
    .map(log => log.output)
    .filter(Boolean) || [];

  const messageLogs = [];
  logs.forEach(log => {
    const { input, ...output } = log;

    const answer = {
      role: 'assistant',
      content: (output && typeof output === 'string') ? output : JSON.stringify(output)
    }

    // first log is the answer (it 'll be reversed)
    output && messageLogs.push(answer);

    const tryParseInput = (input) => {
      try {
        return JSON.parse(input);
      } catch (e) {
        return input;
      }
    }

    if (['functionCall', 'taskManager'].indexOf(functionName) !== -1) {
      if (!input || (typeof input === 'string' && !tryParseInput(input))) {
        return;
      }
    }

    const question = {
      role: 'user',
      content: (input && typeof input === 'string') ? input : JSON.stringify(input)
    }
    input && messageLogs.push(question);

  })

  return messageLogs.reverse();
}




export default (shared) => {
  return {
    ...shared,
    utils: {
      ...shared?.utils,
      createPrompt,
      getThreadHistory: getThreadHistory.bind(shared),
      mentionsExtractor,
      jsonSchemaToShortSchema,
      mergeSchemas,
      sleep,
      _: lodash
    }
  }
}
