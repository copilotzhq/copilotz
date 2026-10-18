/** Ordinary root-authored plugin, shared unchanged by host and worker artifacts. */
import {
  type ActionContext,
  createCopilotz,
  defineAction,
  defineCollection,
  definePlugin,
  defineProcessor,
  defineView,
  type OwnerConnectionOptions,
  type ProcessorContext,
} from "@copilotz/copilotz";

/** The built-artifact fixture exercises actual read calls, not just graph import. */
async function verifyArtifactReads(
  ctx: ActionContext | ProcessorContext,
  value: string,
) {
  if (value !== "artifact") return;
  const id = `note:${value}`;
  const record = await ctx.collections.notes.get({ id });
  const page = await ctx.collections.notes.list({ where: { id }, limit: 1 });
  const groups = await ctx.collections.notes.aggregate({
    where: { id },
    metrics: { n: { op: "count" } },
  });
  if (
    record?.title !== value || page.length !== 1 || page[0].id !== id ||
    groups[0]?.n !== 1
  ) {
    throw new Error(
      "Built worker Collection reads did not use the owner result.",
    );
  }
}

const collection = (name: string) =>
  defineCollection({
    name,
    schema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
    } as const,
  });
export const plugin = definePlugin({
  id: "public.whole",
  version: "1",
  collections: {
    notes: collection("public_note"),
    replies: collection("public_reply"),
  },
  resources: { presentation: { label: "whole" } },
  adapters: { formatting: { label: (value: string) => `whole:${value}` } },
  actions: {
    write: defineAction({
      id: "public.write",
      inputSchema: { type: "string" } as const,
      outputSchema: { type: "string" } as const,
      async execute(value: string, ctx: ActionContext) {
        // Callback return remains local computation; only the canonical plan crosses.
        const local = await ctx.transaction(({ collections }) => {
          collections.notes.create({ id: `note:${value}`, title: value });
          return new Map([["local", value]]);
        }, { operationKey: "write" });
        if (!(local instanceof Map) || local.get("local") !== value) {
          throw new Error("local callback return changed");
        }
        await verifyArtifactReads(ctx, value);
        return (ctx.adapters.formatting.label as (value: string) => string)(
          value,
        );
      },
    }),
    child: defineAction({
      id: "public.child",
      inputSchema: { type: "string" } as const,
      outputSchema: { type: "string" } as const,
      async execute(value: string, ctx: ActionContext) {
        await ctx.transaction(
          ({ collections }) =>
            collections.replies.create({ id: `reply:${value}`, title: value }),
          { operationKey: "reply" },
        );
        return `child:${value}`;
      },
    }),
  },
  processors: {
    follow: defineProcessor({
      id: "public.follow",
      on: [{ eventType: "public_note.created" }],
      async handle(event, ctx: ProcessorContext) {
        if (ctx.resources.presentation.label !== "whole") {
          throw new Error("resource missing");
        }
        const value =
          (event.data as { record: { title: string } }).record.title;
        await verifyArtifactReads(ctx, value);
        await (ctx.actions.child as (
          input: string,
          options: { operationKey: string },
        ) => Promise<unknown>)(value, { operationKey: "child" });
      },
    }),
  },
  views: {
    note: defineView({
      id: "public.note",
      shows: "public_note",
      renderer: "text",
      modes: ["context"],
      render(item: { title: string }) {
        return item.title;
      },
    }),
  },
});
export function connect(options: Omit<OwnerConnectionOptions, "plugins">) {
  return createCopilotz({ ...options, plugins: [plugin] });
}
