/** A remote executor for the `slow` fixture, run as a child process: executor.ts <port> */
import { createExecutor } from "../../mod.ts";
import { args, env } from "../../../testing/mod.ts";
import slow from "./slow.ts";

const executor = createExecutor({
  plugins: [slow],
  transport: {
    type: "websocket",
    config: { url: `ws://127.0.0.1:${args()[0]}/executors`, allowInsecureLoopback: true },
  },
  key: env("COPILOTZ_EXECUTOR_KEY"),
});
await executor.ready;
