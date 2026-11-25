/**
 * An app served as a deploy serves it, in a process of its own:
 * `lost.ts <listen|serve> <sqlite file> <port file>`. Once it serves, it
 * writes the port it listens on. Another process opening the same file
 * takes its store over, and this one stops by itself: code 1, as `listen`
 * and `serve` exit by default.
 */
import { writeFile } from "node:fs/promises";
import { createRuntime } from "../../../../../runtime/mod.ts";
import { sqliteStore } from "../../../../../stores/sql/sqlite/mod.ts";
import { args } from "../../../../../testing/mod.ts";
import { listen, serve } from "../../mod.ts";

const [how, path, portFile] = args();
// Idle, it checks often: the test waits for nothing else.
const open = async () =>
  await createRuntime({ store: await sqliteStore({ path }), plugins: [], fenceCheck: 50 });
const port = how === "serve"
  ? (await serve(open)).server.port
  : (await listen((await open()).fetch)).port;
await writeFile(portFile, String(port));
