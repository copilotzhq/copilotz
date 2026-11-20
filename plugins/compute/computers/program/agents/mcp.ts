/**
 * The agent's tools, as an MCP server the engines reach: Streamable HTTP on
 * this computer's loopback (`127.0.0.1`, a port of its own), a path per
 * session, each guarded by a secret bearer token of its own. It speaks only
 * what a server of tools needs (`initialize`, `ping`, `tools/list`,
 * `tools/call`, and no resources, for an engine that asks), answering with
 * JSON: no event stream, no session of MCP's own.
 *
 * A tool call is held: it goes to the session's prompt (`call`), and its
 * HTTP request is answered only when the plugin answers it (`settle`), or
 * the session ends. Nothing here runs a tool.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CallResult, EngineTool } from "../../shared/workloads.ts";
import { VERSION } from "../version.ts";
import type { McpServerParams } from "./types.ts";

/** What engines call the server: their tools' prefix (`mcp__copilotz__…` in Claude Code). */
export const MCP_NAME = "copilotz";

/** A tool call the model made, held until it's answered. */
export type HeldCall = {
  /** Its id, which the plugin's answer names. */
  id: string;
  name: string;
  arguments: unknown;
  /** Answers it (once; later answers are ignored). */
  settle(result: Omit<CallResult, "id">): void;
};

/** A session's door to the server. */
export type Endpoint = {
  /** The server, as `session/new` passes it. */
  server: McpServerParams;
  /** Closes the door: its held calls are answered as failed. */
  close(): void;
};

export type Mcp = {
  /** A door for a session with these tools; `call` hears each call it holds. */
  open(tools: EngineTool[], call: (held: HeldCall) => void): Promise<Endpoint>;
  /** Stops the server: every door closes. */
  close(): Promise<void>;
};

/** The MCP versions it answers in, newest first. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** How often a held call's event stream says it's still there. */
const KEEPALIVE = 15_000;

/** The most a request's body may be. */
const MOST = 16 * 1024 * 1024;

type Door = {
  path: string;
  token: Uint8Array;
  tools: Map<string, EngineTool>;
  call: (held: HeldCall) => void;
  held: Set<(result: Omit<CallResult, "id">) => void>;
};

// deno-lint-ignore no-explicit-any
type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const rpcFailure = (id: Message["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

/** Whether the request carries the door's token. */
function authorized(request: IncomingMessage, token: Uint8Array) {
  const given = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  if (!given) return false;
  const bytes = new TextEncoder().encode(given);
  return bytes.length === token.length && timingSafeEqual(bytes, token);
}

/** A request's body, as text (or undefined past `MOST`). */
async function bodyOf(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Uint8Array).length;
    if (size > MOST) return undefined;
    chunks.push(chunk as Uint8Array);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** A tool as `tools/list` says it: its input schema an object's. */
const listed = (tool: EngineTool) => ({
  name: tool.name,
  ...(tool.description ? { description: tool.description } : {}),
  inputSchema: tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema
    : { type: "object" },
});

/** The MCP server: started on the first door, on a port of its own. */
export function createMcp(log: (line: string) => void = () => {}): Mcp {
  const doors = new Map<string, Door>();
  let server: Promise<{ server: Server; port: number }> | undefined;
  let next = 0;

  /** One JSON-RPC request's answer (undefined for a notification). */
  const answer = async (door: Door, message: Message, response: ServerResponse) => {
    const { id, method, params } = message;
    if (id === undefined || id === null || typeof method !== "string") return undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_NAME, version: VERSION },
        });
      }
      case "ping":
        return ok({});
      // It has none: an engine that lists them (Codex) hears so, not an error.
      case "resources/list":
        return ok({ resources: [] });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "tools/list":
        return ok({ tools: [...door.tools.values()].map(listed) });
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string" || !door.tools.has(name)) {
          return rpcFailure(id, -32602, `Unknown tool: ${name}`);
        }
        const result = await new Promise<Omit<CallResult, "id">>((resolve) => {
          let settled = false;
          const settle = (result: Omit<CallResult, "id">) => {
            if (settled) return;
            settled = true;
            door.held.delete(settle);
            resolve(result);
          };
          door.held.add(settle);
          // The engine stopped waiting (it was stopped, or cancelled the call).
          response.once("close", () => settle({ content: "", isError: true }));
          try {
            door.call({
              id: `call_${(++next).toString(36)}_${randomBytes(6).toString("hex")}`,
              name,
              arguments: params?.arguments ?? {},
              settle,
            });
          } catch (error) {
            settle({ content: (error as Error)?.message ?? String(error), isError: true });
          }
        });
        return ok({
          content: [{ type: "text", text: result.content }],
          ...(result.isError ? { isError: true } : {}),
        });
      }
      default:
        return rpcFailure(id, -32601, `Method not found: ${method}`);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const path = (request.url ?? "").split("?")[0];
    const door = doors.get(path);
    if (!door) return reply(404);
    // Only engines on this computer: never a web page (a browser sends its origin).
    if (request.headers.origin) return reply(403);
    if (!authorized(request, door.token)) return reply(401);
    if (request.method !== "POST") return reply(405, undefined, { allow: "POST" });
    const text = await bodyOf(request);
    if (text === undefined) return reply(413);
    let message: Message | Message[];
    try {
      message = JSON.parse(text);
    } catch {
      return reply(400, rpcFailure(null, -32700, "Not JSON"));
    }
    const held = !Array.isArray(message) && message?.method === "tools/call" &&
      message.id !== undefined && message.id !== null &&
      /text\/event-stream/.test(String(request.headers.accept ?? ""));
    if (held) {
      // Its headers now, then a comment now and then, so no client takes it for gone.
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.on("error", () => {});
      const still = () => {
        if (!response.writableEnded && !response.destroyed) response.write(": held\n\n");
      };
      still();
      const timer = setInterval(still, KEEPALIVE);
      try {
        const answered = await answer(door, message as Message, response);
        if (!response.writableEnded && !response.destroyed) {
          response.end(`event: message\ndata: ${JSON.stringify(answered)}\n\n`);
        }
      } finally {
        clearInterval(timer);
      }
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const answers = (await Promise.all(messages.map((m) => answer(door, m ?? {}, response))))
      .filter((a) => a !== undefined);
    if (!answers.length) return reply(202);
    reply(200, Array.isArray(message) ? answers : answers[0]);
  };

  /** Closes a door: what it holds is answered as failed. */
  const shut = (door: Door) => {
    doors.delete(door.path);
    for (const settle of [...door.held]) {
      settle({ content: "The session ended before this call was answered", isError: true });
    }
  };

  const start = () =>
    server ??= new Promise((resolve, reject) => {
      const http = createServer((request, response) => {
        handle(request, response).catch((error) => {
          log(`the tools' server failed a request: ${error?.message ?? error}`);
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      // A held call waits as long as its person takes.
      http.timeout = 0;
      http.requestTimeout = 0;
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        http.on("error", (error) => log(`the tools' server: ${error.message}`));
        resolve({ server: http, port: (http.address() as { port: number }).port });
      });
    });

  return {
    async open(tools, call) {
      const { port } = await start();
      const token = randomBytes(32).toString("hex");
      const path = `/mcp/${randomBytes(12).toString("hex")}`;
      const door: Door = {
        path,
        token: new TextEncoder().encode(token),
        tools: new Map(tools.map((tool) => [tool.name, tool])),
        call,
        held: new Set(),
      };
      doors.set(path, door);
      return {
        server: {
          type: "http",
          name: MCP_NAME,
          url: `http://127.0.0.1:${port}${path}`,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        },
        close: () => shut(door),
      };
    },
    async close() {
      for (const door of [...doors.values()]) shut(door);
      const running = await server?.catch(() => undefined);
      server = undefined;
      if (!running) return;
      running.server.closeAllConnections?.();
      await new Promise<void>((resolve) => running.server.close(() => resolve()));
    },
  };
}
