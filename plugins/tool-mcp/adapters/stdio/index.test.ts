import { assertRejects } from "@std/assert";
import { connectMcp } from "./index.ts";

Deno.test("MCP stdio Adapter rejects a missing transport before loading the SDK", async () => {
  await assertRejects(
    () => connectMcp({ id: "missing", name: "Missing transport" }),
    Error,
    "requires a supported stdio transport",
  );
});
