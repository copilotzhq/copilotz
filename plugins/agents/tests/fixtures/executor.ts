/**
 * A remote executor for the booking app, run as a child process:
 * executor.ts <port>. A first run of its tool never answers (killing the
 * process cuts it short); its model picks a seat at random.
 */
import { createExecutor } from "../../../../runtime/mod.ts";
import { args, env } from "../../../../testing/mod.ts";
import models from "../../../models/mod.ts";
import { chat } from "../../chat/mod.ts";
import { booking } from "./booking.ts";

const { plugin } = booking({
  hold: ({ retry }) => retry ? undefined : new Promise(() => {}),
  seat: () => 100 + Math.floor(Math.random() * 900),
});

const executor = createExecutor({
  plugins: [models, chat, plugin],
  transport: {
    type: "websocket",
    config: { url: `ws://127.0.0.1:${args()[0]}/executors`, allowInsecureLoopback: true },
  },
  key: env("COPILOTZ_EXECUTOR_KEY"),
});
await executor.ready;
