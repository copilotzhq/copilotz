/**
 * What agents do on a computer of the conversation's space (its desk there:
 * the space's default, or the one a tool's `computer` names): the terminal
 * (their own shell), background jobs, files, the browser and web search, in
 * the space's folder. Running commands, starting jobs and writing files wait
 * for a yes, unless it's been given (see shared/ask.ts). Listed in an
 * agent's `tools` by name.
 */
import type { Tool, ToolContext } from "../../../agents/chat/contract.ts";
import { tool } from "../../../agents/chat/contract.ts";
import { allowed } from "../shared/ask.ts";
import { jobEnv } from "../shared/env.ts";
import type { Asked } from "../shared/settings.ts";
import { touch, whereAwake } from "../shared/wake.ts";
import { browserActionSchema, browserDescription } from "../shared/browser.ts";
import { WORK } from "../shared/workloads.ts";

/** Every tool's choice of computer, when the space has more than one. */
export const computerChoice = {
  type: "string",
  description: "Which of this space's computers to use (its name): the space's default " +
    "unless you say. Your context lists them.",
} as const;

/** What a write or an edit would do, shortly: what its person sees when they're asked. */
const preview = (text: string, lines = 12, chars = 1200) => {
  const kept = text.split("\n").slice(0, lines).join("\n").slice(0, chars);
  return kept.length < text.length ? `${kept}\n…` : kept;
};

/**
 * Does `work` on a computer of the conversation's space (the one `computer`
 * names, else the default): where it goes, whether it may (`asked`: what
 * kind, and what exactly), then the computer's answer.
 */
async function on(
  ctx: ToolContext,
  work: string,
  given: Record<string, unknown>,
  asked?: { kind: Asked; detail: string; preview?: string },
): Promise<unknown> {
  const { computer, ...input } = given;
  // A computer that sleeps (a cloud computer) is woken first.
  const where = await whereAwake(
    ctx,
    ctx.thread,
    `agent:${ctx.agent}`,
    typeof computer === "string" && computer ? computer : undefined,
  );
  if ("missing" in where) return where.missing;
  if (asked) {
    const may = await allowed(ctx, {
      owner: where.answerer,
      for: where.person,
      desk: where.desk._id,
      computer: where.desk.computer,
      ...(where.desk.name ? { name: where.desk.name } : {}),
      ...(where.desk.approve ? { approve: where.desk.approve } : {}),
      agent: ctx.agent,
      thread: ctx.thread,
      in: where.scope.space,
      work: asked.kind,
      detail: asked.detail,
      ...(asked.preview ? { preview: asked.preview } : {}),
    });
    if (may !== true) return may;
  }
  // It was used: it stays awake a while (alongside the work, which doesn't wait on it).
  const touched = touch(ctx, where.desk.computer);
  try {
    // Jobs and shells run with the space's environment (its computers'), and what's given over it.
    const env = work === WORK.jobsStart || work === WORK.terminal
      ? await jobEnv(ctx, where.scope.space, input.env)
      : undefined;
    const answer = await ctx.workers.call("computer", where.desk.computer, work, {
      ...input,
      ...(env ? { env } : {}),
      scope: where.scope,
    });
    // Where the space has several, an answer says which computer it came from.
    return (where.computers ?? 1) > 1 && answer && typeof answer === "object" &&
        !Array.isArray(answer)
      ? { ...answer, computer: where.desk.name ?? where.desk.computer }
      : answer;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await touched;
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
      computer: computerChoice,
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
    "Windows), with the space's environment (your context names it). Read its output with " +
    "job_logs; stop it with stop_job.",
  input: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1 },
      name: { type: "string" },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Environment variables for this job, over the space's (names to values).",
      },
      computer: computerChoice,
    },
    required: ["command"],
  },
  run: (input, ctx) => on(ctx, WORK.jobsStart, input, { kind: "jobs", detail: input.command }),
});

const listJobs = tool({
  description: "Your background jobs in this space, on one of its computers: running and " +
    "finished.",
  input: { type: "object", properties: { computer: computerChoice } },
  run: (input, ctx) => on(ctx, WORK.jobsList, input),
});

const jobLogs = tool({
  description: "What one of your background jobs wrote (the end of it, with tail: characters).",
  input: {
    type: "object",
    properties: {
      id: { type: "string" },
      tail: { type: "integer", minimum: 1 },
      computer: computerChoice,
    },
    required: ["id"],
  },
  run: (input, ctx) => on(ctx, WORK.jobsLogs, input),
});

const stopJob = tool({
  description: "Stops one of your background jobs.",
  input: {
    type: "object",
    properties: { id: { type: "string" }, computer: computerChoice },
    required: ["id"],
  },
  run: (input, ctx) => on(ctx, WORK.jobsStop, input),
});

const listFiles = tool({
  description:
    "Lists a directory in this space's folder (path relative to it; default: the folder).",
  input: { type: "object", properties: { path: { type: "string" }, computer: computerChoice } },
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
      computer: computerChoice,
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
      computer: computerChoice,
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
      computer: computerChoice,
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
      computer: computerChoice,
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
      computer: computerChoice,
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

/**
 * `preview`: an address for what one of the agent's jobs serves (a dev
 * server, a site), for the space's members to open (see actions/preview.ts).
 */
tools.preview = tool({
  description: "Makes a link to what one of your background jobs serves (a dev server, a site), " +
    "for the people of this space to open in their browser: give the job (its id or name; " +
    "it's found on whichever computer runs it) or the port it serves (and the computer, when " +
    "not the default). Start the server with start_job first.",
  input: {
    type: "object",
    properties: {
      job: { type: "string" },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      computer: computerChoice,
    },
  },
  run: async (input, ctx) => {
    // As the agent reads it: a conversation its person doesn't reach has no space for it.
    const thread = await ctx.db.collection<{ in?: string }>("thread").findOne({ _id: ctx.thread });
    if (!thread?.in) return "This conversation isn't in a space, so there's no computer here.";
    try {
      const { url } = await ctx.call<{ url: string }>("computer.preview", {
        in: thread.in,
        ...(input.job ? { job: input.job } : {}),
        ...(input.port ? { port: input.port } : {}),
        ...(input.computer ? { computer: input.computer } : {}),
      });
      return `${url}\nOnly this space's members can open it, signed in to the app.`;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
