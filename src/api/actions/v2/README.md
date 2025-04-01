# Unified Action System

A simplified, powerful approach to define and execute actions in Copilotz.

## Overview

The new action system provides a clean, unified interface for defining actions that can be executed by agents. Actions can be defined in multiple ways:

1. **Direct Functions** - Provide a handler function directly in your code
2. **Remote Functions** - Load handlers from URLs or data URLs
3. **OpenAPI Schemas** - Convert OpenAPI definitions into executable actions
4. **MCP Servers** - (Coming soon) Connect to Model-Controller-Presenter servers

## Basic Usage

```javascript
import actionHandler from "src/api/actions/v2/main.ts";

// Define your actions
const actions = {
  calculateTotal: {
    name: "Calculate Total",
    description: "Calculate the total price including tax",
    inputSchema: {
      type: "object",
      properties: {
        price: { type: "number", description: "Base price" },
        taxRate: { type: "number", description: "Tax rate percentage" }
      },
      required: ["price"]
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number", description: "Total price including tax" },
        tax: { type: "number", description: "Tax amount" }
      }
    },
    handler: async ({ price, taxRate = 10 }) => {
      const tax = price * (taxRate / 100);
      return { total: price + tax, tax };
    }
  }
};

// Process actions with context
const context = {
  config: { /* configuration */ },
  withHooks: fn => fn, // Optional hook processor
  __requestId__: "req-123",
  // Other context properties...
};

// Initialize actions
const processedActions = await actionHandler.bind(context)(actions);

// Use the actions
const result = await processedActions.calculateTotal({ price: 100 });
console.log(result); // { total: 110, tax: 10 }
```

## Action Definition

An action is defined using this structure:

```typescript
{
  [actionName: string]: {
    name?: string;               // Human readable name
    description?: string;        // Human readable description
    inputSchema?: object;        // JSON schema for input validation
    outputSchema?: object;       // JSON schema for output validation
    handler?: Function | string; // Function or URL to handle the action
    openAPISchema?: string;      // OpenAPI schema URL or content
    mcpServer?: object;          // MCP server configuration
  }
}
```

You only need to provide one of these:
- `handler` - Function or URL
- `openAPISchema` - OpenAPI specification
- `mcpServer` - MCP server configuration

## Multiple Action Types

### Function Handler

The simplest way to define an action:

```javascript
{
  greet: {
    name: "Greeting",
    description: "Generate a personalized greeting",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person's name" },
        formal: { type: "boolean", description: "Use formal greeting" }
      },
      required: ["name"]
    },
    outputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Greeting message" }
      }
    },
    handler: async ({ name, formal = false }) => {
      const prefix = formal ? "Hello" : "Hi";
      return { message: `${prefix}, ${name}!` };
    }
  }
}
```

### URL Handler

Load a function from a URL:

```javascript
{
  processImage: {
    name: "Process Image",
    description: "Apply filters to an image",
    inputSchema: { /* schema */ },
    outputSchema: { /* schema */ },
    handler: "https://example.com/image-processor.js"
  }
}
```

### Data URL Handler

Embed code directly as a data URL:

```javascript
{
  calculateMortgage: {
    name: "Calculate Mortgage",
    description: "Calculate monthly payment",
    inputSchema: { /* schema */ },
    outputSchema: { /* schema */ },
    handler: `data:text/javascript;charset=utf-8,
      export default async function({ principal, interestRate, term }) {
        // Calculation logic...
        return { monthlyPayment, totalPayment, totalInterest };
      }
    `
  }
}
```

### OpenAPI Schema

Convert an entire API into actions:

```javascript
{
  petStore: {
    name: "Pet Store API",
    description: "Operations for the pet store",
    openAPISchema: "https://petstore.swagger.io/v2/swagger.json"
  }
}
```

The OpenAPI schema will be parsed to create multiple actions, one for each operationId.

## Function Specs

The system automatically generates human-readable function specifications from JSON schemas. These specs are used by the agent system for function calling.

For example, an action with this input schema:
```javascript
{
  type: "object",
  properties: {
    location: {
      type: "string",
      description: "City name"
    },
    units: {
      type: "string",
      enum: ["metric", "imperial"]
    }
  },
  required: ["location"]
}
```

Will generate a spec like:
```
(Get Weather): !location<string> (City name), units<string>->(Weather information)
```

## Integration with Agents

This action system integrates seamlessly with the agent system:

```javascript
import unifiedAgent from "src/api/agents/unified-agent.ts";
import actionHandler from "src/api/actions/v2/main.ts";

// Define actions
const actions = { /* action definitions */ };

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
  thread: { extId: "thread-id" },
  input: "Calculate the mortgage for a $300,000 loan at 4.5% for 30 years",
}, responseObject);
```

## Advanced Features

### Validation

The system automatically validates inputs and outputs against the provided schemas.

### Error Handling

Actions include comprehensive error handling with appropriate error codes.

### Media Support

Actions that return base64-encoded content will automatically handle it as media in the `__media__` property.

### Context Binding

All actions are bound to the provided context, allowing them to access configuration and other context values.

## Migration from Legacy Action System

The new system consolidates the old `specParsers` and `modules` into a single, unified approach. 

Here's how to migrate from the old system:

```javascript
// Old approach
const oldAction = {
  specs: "/* OpenAPI YAML */",
  specType: "openapi3-yaml",
  module: "native:request"
};

// New approach
const newAction = {
  petStore: {
    name: "Pet Store API",
    description: "Pet store operations",
    openAPISchema: "/* OpenAPI YAML */"
  }
};
```

## Examples

Check out `examples.ts` for complete working examples of different action types. 