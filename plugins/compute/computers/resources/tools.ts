/**
 * What agents do on a computer of the conversation's space (its desk there:
 * the space's default, or the one a tool's `computer` names): the terminal
 * (their own shell), background jobs, files, the browser and web search, in
 * the space's folder. Running commands, starting jobs and writing files wait
 * for a yes, unless it's been given (see shared/ask.ts). Listed in an
 * agent's `tools` by name.
 *
 * Files cross between the chat and the computer both ways: `save_file` puts
 * a file sent in a chat (by the id its message shows the agent) in the
 * folder, a write like any other; `send_file` sends one from the folder into
 * the chat (`chat.say`), for its people to open, up to a chat file's size.
 */
import type { File, Tool, ToolContext } from "../../../agents/chat/contract.ts";
import { FILE_DATA, tool } from "../../../agents/chat/contract.ts";
import { allowed } from "../shared/ask.ts";
import { jobEnv } from "../shared/env.ts";
import type { Asked } from "../shared/settings.ts";
import { touch, whereAwake } from "../shared/wake.ts";
import { browserActionSchema, browserDescription } from "../shared/browser.ts";
import { type FilesRead, WORK, type Written } from "../shared/workloads.ts";

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
    "computer has). Give it in command. Your working directory and environment persist " +
    'between calls. It answers within about a second: if the command is still "running", ' +
    "call again with its commandId to see more, with its commandId and stdin to answer a " +
    "prompt, or with its commandId and operation interrupt to stop it. For servers and other " +
    "long-running commands, use start_job instead.",
  input: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      commandId: {
        type: "string",
        description: "A running command's, to see more of it, answer it or stop it.",
      },
      stdin: { type: "string", description: "Input for the running command (with its commandId)." },
      operation: { enum: ["interrupt"] },
      computer: computerChoice,
    },
    additionalProperties: false,
  },
  run: (input, ctx) => {
    const wrong = misused(input);
    if (wrong) return `Error: nothing ran: ${wrong}`;
    // The computer's shell takes a new command as its input, as its program always has; seeing
    // more of a running one is typing nothing into it.
    const { command, ...rest } = input;
    if (command && rest.commandId === undefined) {
      return on(ctx, WORK.terminal, { ...rest, stdin: command }, {
        kind: "terminal",
        detail: command,
      });
    }
    return on(ctx, WORK.terminal, rest.operation ? rest : { stdin: "", ...rest });
  },
});

/**
 * Why a terminal call can't run as given, else undefined. A call it can't
 * read is refused with what to give instead, never answered with an empty
 * success: a model that sent the command under another name would think it
 * ran.
 */
function misused(input: Record<string, unknown>): string | undefined {
  const known = ["command", "commandId", "stdin", "operation", "computer"];
  const other = Object.keys(input).filter((key) => !known.includes(key));
  if (other.length) {
    return `terminal takes no ${other.join(" or ")}. Give a new command in command; for a ` +
      "running one, its commandId, with stdin to answer it or operation interrupt to stop it.";
  }
  // A running one's commandId with a blank command reads as looking at it.
  if (
    input.command !== undefined && input.commandId !== undefined && String(input.command).trim()
  ) {
    return "command starts a new command; for the running one, give only its commandId to see " +
      "more of it, with stdin to type into it, or with operation interrupt to stop it.";
  }
  if (input.commandId !== undefined) return undefined;
  if (input.command !== undefined) {
    return String(input.command).trim() ? undefined : "command is empty.";
  }
  return input.stdin !== undefined
    ? "stdin answers a running command, with its commandId. Give a new command in command."
    : "give the command to run in command.";
}

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

/** A file's name as a path in the folder: its last part, never a way out of it. */
const nameAsPath = (name: string) => {
  const last = name.split(/[\\/]/).pop()?.trim() ?? "";
  return last && last !== "." && last !== ".." ? last : "file";
};

const saveFile = tool({
  description: "Saves a file sent in this chat into this space's folder on a computer, where " +
    "commands and the other tools reach it (a zip to unpack, data to work on, an image to edit). " +
    "file: its id, as its message shows it ([file … id file-…]). path: where in the folder " +
    "(default: its name, at the top); a file there is replaced.",
  input: {
    type: "object",
    properties: {
      file: { type: "string", minLength: 1, description: "The file's id, from its message." },
      path: { type: "string", minLength: 1 },
      computer: computerChoice,
    },
    required: ["file"],
    additionalProperties: false,
  },
  run: async (input, ctx) => {
    // As the agent reads it: a file of a chat it reaches, sent (a draft is its sender's alone).
    const found = await ctx.db.collection<File>("file").findOne({ _id: input.file });
    if (!found) {
      return `Error: there's no file "${input.file}" here: give the id its message shows ` +
        "(file-…).";
    }
    const path = input.path ?? nameAsPath(found.name);
    const answer = await on(ctx, WORK.filesWrite, {
      path,
      content: found.data,
      encoding: "base64",
      ...(input.computer ? { computer: input.computer } : {}),
    }, { kind: "writes", detail: `save ${found.name} as ${path}` });
    return answer && typeof answer === "object" && "size" in answer
      ? { ...(answer as Written), file: found.name }
      : answer;
  },
});

/** Media types by extension, for a file sent into a chat; anything else is bytes. */
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const typeOf = (name: string) =>
  TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** The most bytes a file sent into a chat holds: a chat file's limit, as base64. */
const SENDABLE = Math.floor(FILE_DATA / 4) * 3;
/** What `send_file` reads at a time. */
const PART = 4 * 1024 * 1024;

const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const encode = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};

const sendFile = tool({
  description: "Sends a file from this space's folder on a computer into this chat, for its " +
    "people to open or download (a report, a chart, a zip you made): up to about 10 MB. text: " +
    "what you say with it, if anything.",
  input: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      text: { type: "string" },
      computer: computerChoice,
    },
    required: ["path"],
    additionalProperties: false,
  },
  run: async (input, ctx) => {
    const { path, text, computer } = input;
    const parts: Uint8Array[] = [];
    let size = 0;
    for (let offset = 0;;) {
      const read = await on(ctx, WORK.filesRead, {
        path,
        offset,
        length: PART,
        ...(computer ? { computer } : {}),
      });
      // What it couldn't read (not there, a folder, offline) says why, as the agent reads it.
      if (!read || typeof read !== "object" || !("content" in read)) return read;
      const got = read as FilesRead;
      if (got.size > SENDABLE) {
        return `Error: ${path} is ${megabytes(got.size)}: a file sent in a chat may be about ` +
          `${megabytes(SENDABLE)} at most. Make it smaller (compress it, split it), or share it ` +
          "another way (a preview link, for what a job serves).";
      }
      const bytes = got.encoding === "base64"
        ? decode(got.content)
        : new TextEncoder().encode(got.content);
      parts.push(bytes);
      size += bytes.length;
      offset += bytes.length;
      if (!got.truncated || !bytes.length) break;
    }
    const whole = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      whole.set(part, at);
      at += part.length;
    }
    const name = nameAsPath(path);
    // Said once, whatever runs it again: its id is the call's.
    const said = await ctx.call<{ message: string }>("chat.say", {
      id: `send_file:${ctx.callId}`,
      thread: ctx.thread,
      from: ctx.agent,
      ...(text?.trim() ? { text } : {}),
      files: [{ name, type: typeOf(name), data: encode(whole) }],
    });
    return { sent: name, path, size, message: said.message };
  },
});

/** Bytes as a person reads them: "3.2 MB". */
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

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
  save_file: saveFile,
  send_file: sendFile,
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
    if (!ctx.in) return "This conversation isn't in a space, so there's no computer here.";
    try {
      const { url } = await ctx.call<{ url: string }>("computer.preview", {
        in: ctx.in,
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
