import { assertEquals, assertRejects } from "@std/assert";
import { fileURLToPath } from "node:url";
import { connectMcp } from "./index.ts";

Deno.test("MCP stdio Adapter rejects a missing transport before loading the SDK", async () => {
  await assertRejects(
    () => connectMcp({ id: "missing", name: "Missing transport" }),
    Error,
    "requires a supported stdio transport",
  );
});

Deno.test("stdio connector resolves the SDK and closes a real MCP session", async () => {
  const serverPath = new URL(
    "../../../../scripts/fixtures/mcp-echo-server.ts",
    import.meta.url,
  );
  const connection = await connectMcp({
    id: "echo",
    name: "Echo",
    transport: {
      type: "stdio",
      command: Deno.execPath(),
      args: ["run", "-A", fileURLToPath(serverPath)],
    },
  });
  try {
    const tools = await connection.listTools();
    assertEquals(tools.map((tool) => tool.name), ["echo"]);
    const result = await connection.callTool("echo", { text: "hello" });
    assertEquals((result as { content: unknown }).content, [{
      type: "text",
      text: "hello",
    }]);
  } finally {
    await connection.close();
  }
});
