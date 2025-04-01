# Action System Migration Guide

This document provides guidance on transitioning from the old action system to the new unified action system.

## Timeline

1. **Phase 1 - Parallel Systems**: Keep both systems running side by side
2. **Phase 2 - Gradual Migration**: Start migrating actions to the new system
3. **Phase 3 - Complete Transition**: Switch entirely to the new system

## Migration Steps

### Step 1: Update Import Path

Start by changing your imports to use the new action system:

```javascript
// Old approach
import actionExecutor from 'src/api/actions/main.js';

// New approach - backward compatible
import actionExecutor from 'src/api/actions/v2/index.ts';

// New approach - using new API
import { actionHandler } from 'src/api/actions/v2/index.ts';
```

### Step 2: Convert Action Definitions

#### OpenAPI Actions

**Old Format:**
```javascript
{
  specs: openApiYamlString,
  specType: 'openapi3-yaml',
  module: 'native:request',
  config: {
    name: 'petStore'
  }
}
```

**New Format:**
```javascript
{
  petStore: {
    name: 'Pet Store API',
    description: 'API for pet store operations',
    openAPISchema: openApiYamlString
  }
}
```

#### JSON Schema Actions

**Old Format:**
```javascript
{
  specs: jsonSchemaObject,
  specType: 'json-schema',
  module: 'native:validate',
  config: {
    name: 'validateUser'
  }
}
```

**New Format:**
```javascript
{
  validateUser: {
    name: 'Validate User',
    description: 'Validate user data',
    inputSchema: jsonSchemaObject,
    outputSchema: {
      type: 'object',
      properties: {
        valid: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'string' } }
      }
    },
    handler: async (data) => {
      // Validation logic
      return { valid: true, errors: [] };
    }
  }
}
```

#### Custom Module Actions

**Old Format:**
```javascript
{
  specs: jsonSchemaObject,
  specType: 'json-schema',
  module: 'https://example.com/my-custom-module.js',
  config: {
    name: 'customAction'
  }
}
```

**New Format:**
```javascript
{
  customAction: {
    name: 'Custom Action',
    description: 'Performs a custom operation',
    inputSchema: jsonSchemaObject,
    handler: 'https://example.com/my-custom-module.js'
  }
}
```

### Step 3: Update Function Calls

#### Old Approach:

```javascript
const actionFunctions = await actionExecutor.bind(context)({
  specs: openApiYamlString,
  specType: 'openapi3-yaml',
  module: 'native:request'
});

// Use the returned functions
const result = await actionFunctions.getPets({ limit: 10 });
```

#### New Approach:

```javascript
// Define actions
const actions = {
  petStore: {
    name: 'Pet Store API',
    description: 'API for pet store operations',
    openAPISchema: openApiYamlString
  }
};

// Process actions
const actionFunctions = await actionHandler.bind(context)(actions);

// Use the returned functions
const result = await actionFunctions.getPets({ limit: 10 });
```

## Integration with Agent System

The new action system works seamlessly with the agent system:

```javascript
import unifiedAgent from 'src/api/agents/unified-agent.ts';
import { actionHandler } from 'src/api/actions/v2/index.ts';

// Define actions
const actions = {
  calculateMortgage: {
    name: 'Calculate Mortgage',
    description: 'Calculate monthly mortgage payment',
    inputSchema: { /* schema */ },
    outputSchema: { /* schema */ },
    handler: async ({ principal, rate, term }) => {
      // Calculation logic
      return { monthlyPayment, totalPayment, totalInterest };
    }
  }
};

// Process actions
const context = { /* context */ };
const processedActions = await actionHandler.bind(context)(actions);

// Use with agent
const agentResponse = await unifiedAgent.bind(context)({
  resources: {
    copilotz: {
      actions: processedActions
    }
  },
  user: { /* user info */ },
  thread: { extId: 'thread-id' },
  input: 'Calculate the mortgage for a $300,000 loan at 4.5% for 30 years',
}, responseObject);
```

## Testing Your Migration

We've provided example actions and a demonstration utility to help you test:

```javascript
import { demonstrateActions } from 'src/api/actions/v2/index.ts';

// Run the demonstration with your context
await demonstrateActions.bind(context)();
```

## Full Migration Example

Here's a complete example of migrating a set of actions:

```javascript
// OLD CODE
import actionExecutor from 'src/api/actions/main.js';

const context = { /* context */ };

const weatherAction = await actionExecutor.bind(context)({
  specs: weatherSchema,
  specType: 'json-schema',
  module: 'https://weather-api.example.com/module.js',
  config: { name: 'getWeather' }
});

const userApi = await actionExecutor.bind(context)({
  specs: userApiYaml,
  specType: 'openapi3-yaml',
  module: 'native:request',
  config: { name: 'users' }
});

// NEW CODE
import { actionHandler } from 'src/api/actions/v2/index.ts';

const context = { /* context */ };

const actions = {
  getWeather: {
    name: 'Get Weather',
    description: 'Get current weather for a location',
    inputSchema: weatherSchema,
    handler: 'https://weather-api.example.com/module.js'
  },
  users: {
    name: 'User API',
    description: 'User management operations',
    openAPISchema: userApiYaml
  }
};

const allActions = await actionHandler.bind(context)(actions);
```

## Help and Support

If you encounter any issues during migration, refer to the extensive documentation:

- [README.md](./README.md) - Overview and basic usage
- [examples.ts](./examples.ts) - Complete working examples

For more complex scenarios or custom requirements, contact the team. 