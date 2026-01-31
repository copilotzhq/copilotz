/**
 * Example: Single agent with custom collections and namespace support.
 * 
 * Demonstrates:
 * - Setting default namespace at createCopilotz level
 * - Overriding namespace per-run
 * - Using scopedCollections in tools (no manual withNamespace needed)
 * 
 * Run with: deno run -A --env example.ts
 */

import { createCopilotz, defineCollection } from "./index.ts";
import type { ToolExecutionContext } from "./event-processors/tool_call/index.ts";
import type { ScopedCollectionCrud } from "./database/collections/types.ts";

// Get API key from environment
const OPENAI_API_KEY = Deno.env.get("DEFAULT_OPENAI_KEY");
if (!OPENAI_API_KEY) {
  console.error("❌ Error: DEFAULT_OPENAI_KEY environment variable is required");
  console.error("   Run with: DEFAULT_OPENAI_KEY=sk-... deno run -A --env example.ts");
  Deno.exit(1);
}

// Define a simple task collection schema
const taskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", readOnly: true },
    title: { type: "string" },
    description: { type: "string" },
    completed: { type: "boolean" },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "title"],
} as const;

// Create a collection definition
const tasks = defineCollection({
  name: "task",
  schema: taskSchema,
  defaults: {
    completed: false,
    priority: "medium",
  },
  indexes: ["completed", "priority"],
});

// Infer types from the collection
type Task = typeof tasks.$inferSelect;
type TaskInsert = typeof tasks.$inferInsert;

// ============================================
// CUSTOM TOOLS THAT USE COLLECTIONS
// ============================================

/**
 * Tool that creates a task using collections.
 * When namespace is set, collections are automatically scoped!
 */
const createTaskTool = {
  id: "create_task",
  key: "create_task",
  name: "Create Task",
  description: "Create a new task in the task list",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Task title" },
      description: { type: "string", description: "Task description" },
      priority: { type: "string", enum: ["low", "medium", "high"], description: "Task priority" },
    },
    required: ["title"],
  },
  execute: async (
    params: { title: string; description?: string; priority?: "low" | "medium" | "high" },
    context?: ToolExecutionContext,
  ) => {
    // Use collections - automatically scoped to namespace when set!
    const taskCollection = context?.collections?.task as ScopedCollectionCrud<Task, TaskInsert> | undefined;
    if (!taskCollection) {
      return { error: "Collections not available" };
    }

    const task = await taskCollection.create({
      title: params.title,
      description: params.description,
      priority: params.priority ?? "medium",
    });

    return { success: true, task };
  },
};

/**
 * Tool that lists tasks using scopedCollections.
 */
const listTasksTool = {
  id: "list_tasks",
  key: "list_tasks",
  name: "List Tasks",
  description: "List all tasks, optionally filtered by status or priority",
  inputSchema: {
    type: "object" as const,
    properties: {
      completed: { type: "boolean", description: "Filter by completion status" },
      priority: { type: "string", enum: ["low", "medium", "high"], description: "Filter by priority" },
    },
  },
  execute: async (
    params: { completed?: boolean; priority?: "low" | "medium" | "high" },
    context?: ToolExecutionContext,
  ) => {
    const taskCollection = context?.collections?.task as ScopedCollectionCrud<Task, TaskInsert> | undefined;
    if (!taskCollection) {
      return { error: "Collections not available" };
    }

    const filter: Record<string, unknown> = {};
    if (params.completed !== undefined) filter.completed = params.completed;
    if (params.priority) filter.priority = params.priority;

    const tasksList = await taskCollection.find(filter);
    return { tasks: tasksList, count: tasksList.length };
  },
};

/**
 * Tool that marks a task as complete.
 */
const completeTaskTool = {
  id: "complete_task",
  key: "complete_task",
  name: "Complete Task",
  description: "Mark a task as completed by its ID",
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: { type: "string", description: "The ID of the task to complete" },
    },
    required: ["taskId"],
  },
  execute: async (
    params: { taskId: string },
    context?: ToolExecutionContext,
  ) => {
    const taskCollection = context?.collections?.task as ScopedCollectionCrud<Task, TaskInsert> | undefined;
    if (!taskCollection) {
      return { error: "Collections not available" };
    }

    await taskCollection.update({ id: params.taskId }, { completed: true });
    const updated = await taskCollection.findById(params.taskId);

    return { success: true, task: updated };
  },
};

// ============================================
// MAIN EXAMPLE
// ============================================

const NAMESPACE = "tenant-demo";

async function main() {
  console.log("🚀 Starting Task Management Agent Example\n");
  console.log(`📦 Using namespace: "${NAMESPACE}"\n`);

  // Create Copilotz with default namespace
  // All operations will be scoped to this namespace unless overridden per-run
  const copilotz = await createCopilotz({
    agents: [
      {
        id: "assistant",
        name: "Task Assistant",
        role: "A helpful assistant that manages tasks",
        instructions: `You are a task management assistant. You help users manage their to-do list.

Available actions:
- List tasks (can filter by completed status or priority)
- Create new tasks
- Mark tasks as complete

When asked to complete a task, first list the tasks to find the task ID, then use the complete_task tool with that ID.
Be concise in your responses.`,
        llmOptions: {
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: OPENAI_API_KEY,
        },
        allowedTools: ["create_task", "list_tasks", "complete_task"],
      },
    ],
    tools: [createTaskTool, listTasksTool, completeTaskTool],
    collections: [tasks],
    // ⭐ NEW: Set default namespace for all runs
    namespace: NAMESPACE,
    stream: true,
  });

  // ============================================
  // STEP 1: Create initial tasks directly
  // ============================================
  console.log("📝 Creating initial tasks...\n");

  // Direct collection access still works with manual namespace
  const db = copilotz.collections!.withNamespace(NAMESPACE);
  const taskDb = db.task as ScopedCollectionCrud<Task, TaskInsert>;

  const task1 = await taskDb.create({
    title: "Buy groceries",
    description: "Milk, eggs, bread",
    priority: "high",
  });
  console.log(`  ✓ Created: "${task1.title}" (ID: ${task1.id})`);

  const task2 = await taskDb.create({
    title: "Call mom",
    priority: "medium",
  });
  console.log(`  ✓ Created: "${task2.title}" (ID: ${task2.id})`);

  const task3 = await taskDb.create({
    title: "Review PR",
    description: "Check the new feature branch",
    priority: "high",
  });
  console.log(`  ✓ Created: "${task3.title}" (ID: ${task3.id})`);

  // ============================================
  // STEP 2: Have conversation with agent
  // ============================================
  console.log("\n💬 Starting conversation with agent...\n");
  console.log("─".repeat(50));

  // Helper to run a message and stream the response
  async function chat(message: string, namespaceOverride?: string) {
    console.log(`\n👤 User: ${message}\n`);
    if (namespaceOverride) {
      console.log(`   (namespace override: ${namespaceOverride})`);
    }
    console.log("🤖 Assistant: ");

    const result = await copilotz.run(
      {
        content: message,
        sender: { type: "user", name: "Demo User" },
        thread: { externalId: NAMESPACE },
      },
      // Event handler to show tool calls
      async (event) => {
        if (event.type === "TOOL_CALL") {
          const payload = event.payload as { call?: { name?: string; arguments?: unknown } };
          if (payload.call?.name) {
            console.log(`\n  🔧 [Tool: ${payload.call.name}]`);
            console.log(`     Args: ${JSON.stringify(payload.call.arguments)}`);
          }
        }
      },
      // ⭐ NEW: Can override namespace per-run
      namespaceOverride ? { namespace: namespaceOverride } : undefined,
    );

    // Stream the response tokens
    for await (const event of result.events) {
      if (event.type === "TOKEN") {
        const token = (event.payload as { token?: string }).token;
        if (token) {
          await Deno.stdout.write(new TextEncoder().encode(token));
        }
      }
    }

    await result.done;
    console.log("\n");
  }

  // Conversation: Ask agent to list and complete a task
  // (uses default namespace from createCopilotz)
  await chat("What tasks do I have?");

  await chat(`Please mark the "Buy groceries" task as complete.`);

  await chat("Show me my remaining incomplete tasks.");

  // ============================================
  // STEP 3: Demonstrate namespace override
  // ============================================
  console.log("─".repeat(50));
  console.log("\n🔀 Demonstrating namespace override:\n");
  
  // This will use a different namespace - no tasks will be found
  await chat("What tasks do I have?", "tenant-other");

  // ============================================
  // STEP 4: Verify the task was completed
  // ============================================
  console.log("─".repeat(50));
  console.log("\n📊 Final task status (direct DB query):\n");

  const finalTasks = await taskDb.find({});
  for (const task of finalTasks) {
    const status = task.completed ? "✅" : "⬜";
    console.log(`  ${status} ${task.title} (${task.priority})`);
  }

  // Cleanup
  await copilotz.shutdown();
  console.log("\n✨ Done!");
}

main().catch(console.error);
