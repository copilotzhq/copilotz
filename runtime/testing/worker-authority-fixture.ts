import { defineAction } from "../actions/define.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { defineCollection } from "../collections/definition.ts";
import type { CopilotzApplication } from "../application/types.ts";
import type { ActionContext } from "../actions/types.ts";

export const notes = defineCollection({
  name: "authority_note",
  schema: { type: "object" },
});
export type Probe = { id: string; via?: string; target?: string };
export function authorityDefinitions(
  host: () => Pick<CopilotzApplication, "actions" | "collections">,
) {
  const work = async (
    input: Probe,
    ctx: Pick<ActionContext, "actions" | "collections">,
  ) => {
    await Promise.resolve();
    if (input.target === "foreign") {
      return await host().collections.notes.list({}, { namespace: "foreign" });
    }
    if (input.target === "foreign-schema") {
      return await host().collections.notes.list({}, {
        databaseSchema: "foreign",
      });
    }
    if (input.target === "write") {
      return input.via === "context"
        ? await ctx.collections.notes.create({ id: input.id })
        : await host().collections.notes.create({ id: input.id });
    }
    return input.via === "context"
      ? await ctx.actions.child(input, { operationKey: input.id })
      : await host().actions.child(input, { idempotencyKey: input.id });
  };
  return {
    collections: { notes },
    actions: {
      probe: defineAction({
        id: "authority.probe",
        execute: (input: Probe, ctx) => work(input, ctx),
      }),
      prepare: defineAction({
        id: "authority.prepare",
        execute: (input: Probe, ctx) =>
          ctx.actions.child.prepare(async () => {
            await work({ ...input, target: "write" }, ctx);
            return { input: { id: `${input.id}-child` } };
          }, { operationKey: input.id }),
      }),
      directory: defineAction({
        id: "authority.directory",
        execute: (input: { alias: string; id: string }, ctx) =>
          ctx.directory.get(input.alias, input.id),
      }),
      child: defineAction({
        id: "authority.child",
        async execute(input: Probe, ctx) {
          await ctx.collections.notes.create({ id: input.id });
          return { id: input.id, process: Deno.pid };
        },
      }),
    },
    processors: {
      probe: defineProcessor<
        import("../plugins/processor.ts").ProcessorContext<
          ActionContext["resources"],
          ActionContext["adapters"],
          ActionContext["actions"]
        >
      >({
        id: "authority.processor",
        on: [{ eventType: "authority.requested" }],
        async handle(event, ctx) {
          if ((event.data as Probe).target === "error") {
            throw Object.assign(new Error("handler error"), {
              retryable: false,
            });
          }
          await work(event.data as Probe, ctx);
        },
        async onError(_error, event, ctx) {
          if ((event.data as Probe).target !== "error") return false;
          await work({ ...event.data as Probe, target: "write" }, ctx);
          return true;
        },
      }),
    },
  };
}
