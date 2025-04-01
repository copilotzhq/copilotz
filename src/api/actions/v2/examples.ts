/**
 * Example Actions for the new action system
 * ====================================================================
 */

import type { ActionArray } from './actionHandler.ts';

// Type definition for actions with spec property
interface ActionFunction extends Function {
  spec?: string;
}

/**
 * Example actions configuration showing different ways to define actions
 */
export const exampleActions: ActionArray = [
  // Example 1: Simple function with schemas
  {
    name: "getWeather",
    displayName: "Get Weather",
    description: "Get current weather for a location",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name or coordinates"
        },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "Temperature units"
        }
      },
      required: ["location"]
    },
    outputSchema: {
      type: "object",
      properties: {
        temperature: {
          type: "number",
          description: "Current temperature"
        },
        conditions: {
          type: "string",
          description: "Weather conditions"
        },
        humidity: {
          type: "number",
          description: "Humidity percentage"
        }
      },
      description: "Weather information"
    },
    // Example handler as a function
    handler: async ({ location, units = "metric" }: { location: string; units?: string }) => {
      console.log(`Getting weather for ${location} in ${units}`);
      // Mock implementation - in real usage, this would call a weather API
      return {
        temperature: 22,
        conditions: "Sunny",
        humidity: 45
      };
    }
  },

  // Example 2: Using a JavaScript module URL (data URL)
  {
    name: "calculateMortgage",
    displayName: "Calculate Mortgage",
    description: "Calculate monthly mortgage payment",
    inputSchema: {
      type: "object",
      properties: {
        principal: {
          type: "number",
          description: "Loan amount"
        },
        interestRate: {
          type: "number",
          description: "Annual interest rate (percentage)"
        },
        loanTerm: {
          type: "number",
          description: "Loan term in years"
        }
      },
      required: ["principal", "interestRate", "loanTerm"]
    },
    outputSchema: {
      type: "object",
      properties: {
        monthlyPayment: {
          type: "number",
          description: "Monthly payment amount"
        },
        totalPayment: {
          type: "number",
          description: "Total payment over the loan term"
        },
        totalInterest: {
          type: "number",
          description: "Total interest paid"
        }
      },
      description: "Mortgage payment details"
    },
    // Example of code in a data URL
    handler: `data:text/javascript;charset=utf-8,
      export default async function({ principal, interestRate, loanTerm }) {
        // Convert annual rate to monthly rate and convert percentage to decimal
        const monthlyRate = (interestRate / 100) / 12;
        const totalMonths = loanTerm * 12;
        
        // Calculate monthly payment using mortgage formula
        const monthlyPayment = principal * 
          (monthlyRate * Math.pow(1 + monthlyRate, totalMonths)) / 
          (Math.pow(1 + monthlyRate, totalMonths) - 1);
        
        const totalPayment = monthlyPayment * totalMonths;
        const totalInterest = totalPayment - principal;
        
        return {
          monthlyPayment: parseFloat(monthlyPayment.toFixed(2)),
          totalPayment: parseFloat(totalPayment.toFixed(2)),
          totalInterest: parseFloat(totalInterest.toFixed(2))
        };
      }
    `
  },

  // Example 3: Using OpenAPI Schema
  {
    name: "userApi",
    displayName: "User API",
    description: "Operations for user management",
    // This would be a URL to an OpenAPI schema in production
    openAPISchema: `
      openapi: 3.0.0
      info:
        title: User API
        version: 1.0.0
        description: API for user management
      servers:
        - url: https://api.example.com/v1
      paths:
        /users:
          get:
            operationId: getUsers
            summary: Get all users
            description: Retrieve a list of all users
            parameters:
              - name: limit
                in: query
                description: Maximum number of users to return
                schema:
                  type: integer
                  default: 10
              - name: offset
                in: query
                description: Offset for pagination
                schema:
                  type: integer
                  default: 0
            responses:
              '200':
                description: A list of users
                content:
                  application/json:
                    schema:
                      type: object
                      properties:
                        users:
                          type: array
                          items:
                            type: object
                            properties:
                              id:
                                type: string
                              name:
                                type: string
                              email:
                                type: string
                        total:
                          type: integer
          post:
            operationId: createUser
            summary: Create a new user
            description: Add a new user to the system
            requestBody:
              content:
                application/json:
                  schema:
                    type: object
                    properties:
                      name:
                        type: string
                      email:
                        type: string
                    required:
                      - name
                      - email
            responses:
              '201':
                description: User created successfully
                content:
                  application/json:
                    schema:
                      type: object
                      properties:
                        id:
                          type: string
                        name:
                          type: string
                        email:
                          type: string
        /users/{userId}:
          get:
            operationId: getUserById
            summary: Get user by ID
            description: Retrieve a specific user by their ID
            parameters:
              - name: userId
                in: path
                required: true
                description: ID of the user to retrieve
                schema:
                  type: string
            responses:
              '200':
                description: User details
                content:
                  application/json:
                    schema:
                      type: object
                      properties:
                        id:
                          type: string
                        name:
                          type: string
                        email:
                          type: string
                        createdAt:
                          type: string
                          format: date-time
    `
  }
];

/**
 * Example usage of the action system
 */
export async function demonstrateActions(this: any) {
  const context = this || {};
  
  // Import the action handler
  const { default: actionHandler } = await import('./main.ts');

  // Process the actions
  const actions = await actionHandler.bind(context)(exampleActions);

  console.log("Available actions:");
  Object.entries(actions).forEach(([name, fn]) => {
    const actionFn = fn as ActionFunction;
    console.log(`- ${name}: ${actionFn.spec || 'No spec available'}`);
  });

  // Example calls
  try {
    // Call the weather action
    const weatherResult = await actions.getWeather({ 
      location: "London", 
      units: "metric" 
    });
    console.log("Weather result:", weatherResult);

    // Call the mortgage calculator
    const mortgageResult = await actions.calculateMortgage({ 
      principal: 300000, 
      interestRate: 4.5, 
      loanTerm: 30 
    });
    console.log("Mortgage result:", mortgageResult);

    // OpenAPI actions would make actual HTTP requests in a real environment
    console.log("OpenAPI endpoints available:", 
      Object.keys(actions).filter(name => name.startsWith("get") || 
                                          name.startsWith("create") || 
                                          name.includes("User"))
    );
  } catch (error) {
    console.error("Error calling actions:", error);
  }
}

// Export some example code snippets to show in documentation
export const snippets = {
  basicAction: `
// Basic action with direct function handler
const actions = [
  {
    name: "calculateTotal",
    displayName: "Calculate Total",
    description: "Calculate the total price including tax",
    inputSchema: {
      type: "object",
      properties: {
        price: {
          type: "number",
          description: "Base price"
        },
        taxRate: {
          type: "number",
          description: "Tax rate percentage"
        }
      },
      required: ["price"]
    },
    outputSchema: {
      type: "object",
      properties: {
        total: {
          type: "number",
          description: "Total price including tax"
        },
        tax: {
          type: "number",
          description: "Tax amount"
        }
      }
    },
    handler: async ({ price, taxRate = 10 }) => {
      const tax = price * (taxRate / 100);
      return {
        total: price + tax,
        tax
      };
    }
  }
];
  `,

  openApiAction: `
// Using OpenAPI schema URL
const actions = [
  {
    name: "petStore",
    displayName: "Pet Store API",
    description: "Operations for the pet store",
    openAPISchema: "https://petstore.swagger.io/v2/swagger.json"
  }
];
  `,

  urlAction: `
// Using a URL to load the handler function
const actions = [
  {
    name: "processImage",
    displayName: "Process Image",
    description: "Apply filters to an image",
    inputSchema: { /* schema */ },
    outputSchema: { /* schema */ },
    handler: "https://example.com/image-processor.js"
  }
];
  `
}; 