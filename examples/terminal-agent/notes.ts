/**
 * Notes, for the terminal agent: short notes that live in spaces, two tools
 * agents use them with, and two Actions people do (`note.write`,
 * `note.remove`; on the web, a space's Notes tab: notes-web.tsx). Notes are
 * shared like chats, so an agent reading Finance's notes to answer in
 * Launch writes an answer that carries Finance: only those who see Finance
 * read it, until someone shares it.
 */
import { defineAction, defineCollection, definePlugin } from "../../runtime/mod.ts";
import { type Thread, tool } from "../../plugins/agents/mod.ts";

export type Note = { _id: string; in: string; text: string; by: string; at?: string };
type Space = { _id: string; name: string };

const spaceOf = async (ctx: Parameters<Parameters<typeof tool>[0]["run"]>[1]) =>
  (await ctx.db.collection<Thread>("thread").findOne({ _id: ctx.thread }))?.in;

export const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: {
        type: "object",
        properties: {
          in: { type: "string" },
          text: { type: "string" },
          by: { type: "string" },
          at: { type: "string" },
        },
        required: ["in", "text"],
      },
      indexes: [["in"]],
    }),
  },
  actions: {
    // A person's note, in a space they may write in (the rules say).
    "note.write": defineAction({
      description: "Writes a note in a space",
      input: {
        type: "object",
        properties: {
          in: { type: "string" },
          text: { type: "string", minLength: 1, maxLength: 4000 },
        },
        required: ["in", "text"],
        additionalProperties: false,
      },
      allow: (actor) => actor.kind === "person",
      run: async (ctx, input) => {
        const { insertedId } = await ctx.db.collection("note").insertOne({
          in: input.in,
          text: input.text.trim(),
          by: ctx.actor!.id,
          at: new Date().toISOString(),
        });
        return { note: insertedId };
      },
    }),
    // Moved as the person: they must reach it, and may write where it goes (the spaces' rules).
    "note.move": defineAction({
      description: "Moves a note to another space",
      input: {
        type: "object",
        properties: { note: { type: "string" }, to: { type: "string" } },
        required: ["note", "to"],
        additionalProperties: false,
      },
      allow: (actor) => actor.kind === "person",
      run: async (ctx, input) => {
        const { matchedCount } = await ctx.db.collection("note").updateOne(
          { _id: input.note },
          { $set: { in: input.to } },
        );
        return { moved: matchedCount > 0 };
      },
    }),
    "note.remove": defineAction({
      description: "Removes a note",
      input: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      },
      allow: (actor) => actor.kind === "person",
      run: async (ctx, input) => {
        const { deletedCount } = await ctx.db.collection("note").deleteOne({ _id: input.note });
        return { removed: deletedCount > 0 };
      },
    }),
  },
  resources: {
    shared: { note: {} },
    tools: {
      write_note: tool({
        description: "Write a short note where this conversation is, for later.",
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        run: async ({ text }, ctx) => {
          const space = await spaceOf(ctx);
          if (!space) return "This conversation isn't in a space: nowhere to write.";
          await ctx.db.collection("note").insertOne({
            in: space,
            text,
            by: ctx.agent,
            at: new Date().toISOString(),
          });
          return "Noted.";
        },
      }),
      read_notes: tool({
        description: "Read the notes in a space, by its name or id (`in`); without one, " +
          "where this conversation is.",
        input: { type: "object", properties: { in: { type: "string" } } },
        run: async ({ in: space }, ctx) => {
          const spaces = await ctx.db.collection("space").query<Space[]>("reached", {});
          const id = space
            ? spaces.find((p) => p._id === space || p.name.toLowerCase() === space.toLowerCase())
              ?._id
            : await spaceOf(ctx);
          if (!id) return `No space "${space}" that you can see.`;
          const found = await ctx.db.collection<Note>("note").find({ in: id }, {
            sort: { _id: 1 },
          });
          return found.length ? found.map((n) => `- ${n.text}`).join("\n") : "No notes there.";
        },
      }),
    },
  },
});
