import { createCopilotz } from "../../create-copilotz.ts";
import type { HostCommandContext } from "./public.ts";
import type { ProcessorContext } from "../plugins/index.ts";
import { createCopilotzWorker } from "./worker.ts";

// This is checked, never called: host command types cannot leak into workers.
function contract() {
  const app = createCopilotz({
    hostCommands: {
      rename: {
        namespace: "workspace",
        principal: "host-service",
        authorize(input: { id: string; title: string }, context) {
          const typed: HostCommandContext = context;
          void [input.id, typed.scope.databaseSchema];
        },
        execute(input: { id: string; title: string }, context) {
          void context.query<{ id: string }>("SELECT $1 AS id", [input.id]);
          return { id: input.id, changed: true };
        },
      },
    },
  });
  void app.then(async (app) => {
    const result = await app.hostCommands.invoke("rename", {
      id: "id",
      title: "new",
    });
    const id: string = result.id;
    const changed: boolean = result.changed;
    void [id, changed];
    // @ts-expect-error Names are inferred from the registration map.
    await app.hostCommands.invoke("missing", null);
    // @ts-expect-error Inputs are inferred from execute.
    await app.hostCommands.invoke("rename", { id: 1 });
  });
  // @ts-expect-error Host callbacks are forbidden on the worker role.
  void createCopilotz({
    role: "worker",
    transport: { type: "in-process", config: { topic: "types" } },
    hostCommands: {},
  });
  void createCopilotzWorker({
    transport: { type: "in-process", config: { topic: "types" } },
    // @ts-expect-error Startup scopes are forbidden on worker options.
    databaseScopes: [],
  });
  const worker = {} as ProcessorContext;
  // @ts-expect-error Host command invocations never enter execution contexts.
  void worker.hostCommands;
}
void contract;
