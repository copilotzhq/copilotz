/**
 * What agents do on the computer of the conversation's space (its desk
 * there): the terminal (their own shell), background jobs, files, the
 * browser and web search, in the space's folder. Running commands, starting
 * jobs and writing files wait for a yes, unless it's been given (see
 * shared/ask.ts). Listed in an agent's `tools` by name.
 */
import type { Tool, ToolContext } from "../../../agents/chat/contract.ts";
import { tool } from "../../../agents/chat/contract.ts";
import { allowed } from "../shared/ask.ts";
import type { Asked } from "../shared/settings.ts";
import { whereFor } from "../shared/where.ts";
import { browserActionSchema, browserDescription } from "../shared/browser.ts";
import { WORK } from "../shared/workloads.ts";

/** What a write or an edit would do, shortly: what its person sees when they're asked. */
const preview = (text: string, lines = 12, chars = 1200) => {
  const kept = text.split("\n").slice(0, lines).join("\n").slice(0, chars);
  return kept.length < text.length ? `${kept}\n…` : kept;
};

/**
 * Does `work` on the computer of the conversation's space: where it goes,
 * whether it may (`asked`: what kind, and what exactly), then the computer's
 * answer.
 */
async function on(
  ctx: ToolContext,
  work: string,
  input: Record<string, unknown>,
  asked?: { kind: Asked; detail: string; preview?: string },
): Promise<unknown> {
  const where = await whereFor(ctx, ctx.thread, `agent:${ctx.agent}`);
  if ("missing" in where) return where.missing;
  if (asked) {
    const may = await allowed(ctx, {
      owner: where.answerer,
      for: where.person,
      desk: where.desk._id,
      computer: where.desk.computer,
      ...(where.desk.name ? { name: where.desk.name } : {}),
      agent: ctx.agent,
      thread: ctx.thread,
      in: where.scope.space,
      work: asked.kind,
      detail: asked.detail,
      ...(asked.preview ? { preview: asked.preview } : {}),
    });
    if (may !== true) return may;
  }
  try {
    return await ctx.workers.call("computer", where.desk.computer, work, {
      ...input,
      scope: where.scope,
    });
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const terminal = tool({
  description: "Runs a command in your own shell on your person's computer, in this space's " +
    "folder: bash on macOS and Linux, PowerShell on Windows (your context says which this " +
    "computer has). Your working directory and environment persist between calls. It " +
    'answers within about a second: if the command is still "running", call again with its ' +
    "commandId and empty stdin to see more, or with stdin to answer a prompt; operation " +
    "interrupt stops it. For servers and other long-running commands, use start_job instead.",
  input: {
    type: "object",
    properties: {
      stdin: { type: "string", description: "A command, or input for the running one." },
      commandId: { type: "string" },
      operation: { enum: ["interrupt"] },
    },
  },
  run: (input, ctx) =>
    on(
      ctx,
      WORK.terminal,
      input,
      input.stdin && !input.commandId ? { kind: "terminal", detail: input.stdin } : undefined,
    ),
});

const startJob = tool({
  description:
    "Starts a command that keeps running in the background (a dev server, a watcher, a " +
    "long build), in this space's folder, in the terminal's shell (bash, or PowerShell on " +
    "Windows). Read its output with job_logs; stop it with stop_job.",
  input: {
    type: "object",
    properties: { command: { type: "string", minLength: 1 }, name: { type: "string" } },
    required: ["command"],
  },
  run: (input, ctx) => on(ctx, WORK.jobsStart, input, { kind: "jobs", detail: input.command }),
});

const listJobs = tool({
  description: "Your background jobs in this space: running and finished.",
  input: { type: "object", properties: {} },
  run: (_input, ctx) => on(ctx, WORK.jobsList, {}),
});

const jobLogs = tool({
  description: "What one of your background jobs wrote (the end of it, with tail: characters).",
  input: {
    type: "object",
    properties: { id: { type: "string" }, tail: { type: "integer", minimum: 1 } },
    required: ["id"],
  },
  run: (input, ctx) => on(ctx, WORK.jobsLogs, input),
});

const stopJob = tool({
  description: "Stops one of your background jobs.",
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: (input, ctx) => on(ctx, WORK.jobsStop, input),
});

const listFiles = tool({
  description:
    "Lists a directory in this space's folder (path relative to it; default: the folder).",
  input: { type: "object", properties: { path: { type: "string" } } },
  run: (input, ctx) => on(ctx, WORK.filesList, input),
});

const readFile = tool({
  description: "Reads a file in this space's folder (text; base64 when it isn't). Large files " +
    "come in parts: offset and length, in bytes.",
  input: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      offset: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 1 },
    },
    required: ["path"],
  },
  run: (input, ctx) => on(ctx, WORK.filesRead, input),
});

const writeFile = tool({
  description: "Writes a whole file in this space's folder, making its directories.",
  input: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
      encoding: { enum: ["utf8", "base64"] },
    },
    required: ["path", "content"],
  },
  run: (input, ctx) =>
    on(ctx, WORK.filesWrite, input, {
      kind: "writes",
      detail: `write ${input.path}`,
      ...(input.encoding === "base64" ? {} : { preview: preview(input.content) }),
    }),
});

const editFile = tool({
  description: "Changes a file in this space's folder: replaces text that occurs exactly once in " +
    "it (old) with new text.",
  input: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      old: { type: "string", minLength: 1 },
      new: { type: "string" },
    },
    required: ["path", "old", "new"],
  },
  run: (input, ctx) =>
    on(ctx, WORK.filesEdit, input, {
      kind: "writes",
      detail: `edit ${input.path}`,
      preview: preview([
        ...input.old.split("\n").map((line) => `- ${line}`),
        ...input.new.split("\n").map((line) => `+ ${line}`),
      ].join("\n")),
    }),
});

const browser = tool({
  description: browserDescription,
  input: {
    type: "object",
    properties: {
      actions: { type: "array", minItems: 1, maxItems: 10, items: browserActionSchema },
      window: {
        enum: ["hidden", "shown"],
        description:
          "Shown: on your person's screen, for them to watch or use. Default: as it was.",
      },
    },
    required: ["actions"],
  },
  run: (input, ctx) => on(ctx, WORK.browser, input),
});

const webSearch = tool({
  description: "Searches the web: the top results, each a title, link and snippet. Open one with " +
    "the browser to read it.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
  },
  run: (input, ctx) => on(ctx, WORK.search, input),
});

/** By the names agents list them under. */
export const tools: Record<string, Tool> = {
  terminal,
  start_job: startJob,
  list_jobs: listJobs,
  job_logs: jobLogs,
  stop_job: stopJob,
  list_files: listFiles,
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  browser,
  web_search: webSearch,
};
