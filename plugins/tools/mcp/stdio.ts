import type { MCPServer } from "@copilotz/copilotz/resources";
import type {
  ConnectMcpRuntime,
  McpRuntimeConnection,
  McpToolDescriptor,
} from "./types.ts";

type StdioTransport = Readonly<{
  type: "stdio";
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

type SdkTransport = { close(): Promise<void> };
type SdkClient = {
  connect(transport: SdkTransport): Promise<void>;
  listTools(): Promise<Readonly<{ tools?: readonly McpToolDescriptor[] }>>;
  callTool(
    input: Readonly<{ name: string; arguments: unknown }>,
  ): Promise<unknown>;
};

type Constructor<T, Args extends readonly unknown[]> = new (
  ...args: Args
) => T;

function stdioTransport(server: MCPServer): StdioTransport {
  const value = server.transport;
  if (!value || value.type !== "stdio") {
    throw new Error(
      `MCP server '${server.name}' requires a supported stdio transport.`,
    );
  }
  if (typeof value.command !== "string" || !value.command.trim()) {
    throw new TypeError(`MCP server '${server.name}' requires a command.`);
  }
  const args = Array.isArray(value.args)
    ? value.args.map((item) => String(item))
    : undefined;
  const env = value.env && typeof value.env === "object"
    ? Object.fromEntries(
      Object.entries(value.env).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
      ),
    )
    : undefined;
  return Object.freeze({
    type: "stdio",
    command: value.command.trim(),
    ...(args?.length ? { args: Object.freeze(args) } : {}),
    ...(env && Object.keys(env).length ? { env: Object.freeze(env) } : {}),
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("MCP operation cancelled.", "AbortError");
}

async function abortable<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  abort: () => void | Promise<void>,
): Promise<T> {
  if (!signal) return await task;
  if (signal.aborted) {
    await abort();
    throw abortError(signal);
  }
  let remove = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      Promise.resolve(abort()).finally(() => reject(abortError(signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([task, cancelled]);
  } finally {
    remove();
  }
}

/** Server-runtime connector for the official MCP SDK stdio transport. */
export const connectMcp: ConnectMcpRuntime = async (
  server,
  signal,
): Promise<McpRuntimeConnection> => {
  const config = stdioTransport(server);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("../../../dependencies/mcp-client.ts"),
    import("../../../dependencies/mcp-stdio-client.ts"),
  ]);
  const ClientConstructor = Client as unknown as Constructor<
    SdkClient,
    readonly [
      Readonly<{ name: string; version: string }>,
      Readonly<{ capabilities: object }>,
    ]
  >;
  const TransportConstructor = StdioClientTransport as unknown as Constructor<
    SdkTransport,
    readonly [
      Readonly<
        {
          command: string;
          args?: readonly string[];
          env?: Readonly<Record<string, string>>;
        }
      >,
    ]
  >;
  const transport = new TransportConstructor({
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
  });
  const client = new ClientConstructor(
    { name: "Copilotz", version: "3.0.0" },
    { capabilities: {} },
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await transport.close();
  };
  try {
    await abortable(client.connect(transport), signal, close);
  } catch (cause) {
    await close().catch(() => undefined);
    throw new Error(`Failed to connect to MCP server '${server.name}'.`, {
      cause,
    });
  }
  return Object.freeze({
    async listTools(operationSignal) {
      const response = await abortable(
        client.listTools(),
        operationSignal,
        close,
      );
      return Object.freeze([...(response.tools ?? [])]);
    },
    callTool(name, args, operationSignal) {
      return abortable(
        client.callTool({ name, arguments: args }),
        operationSignal,
        close,
      );
    },
    close,
  });
};
