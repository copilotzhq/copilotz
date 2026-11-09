/**
 * What boards' tests run on: the memory store and, given
 * `COPILOTZ_TEST_POSTGRES_URL`, PostgreSQL (each test its own temporary
 * schema); a runtime with chat, spaces and boards, two of the app's agents
 * in every new space (North, South) and one that isn't (West), on a
 * scripted model: "tool <name> <json>" calls that tool with that input,
 * then it says "done" and keeps what the tool answered. People join a space
 * the way they do: invited by email, then accepting.
 */
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
  type Store,
} from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { postgresStore } from "copilotz/stores/postgres";
import { models } from "copilotz/plugins/models";
import type { LlmAdapter, LlmMessage } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { access } from "copilotz/plugins/access";
import { env, temporary } from "copilotz/testing";
import { boards } from "../mod.ts";
import type { Board, Card } from "../contract.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");

export const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `b_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};

export const ana: Actor = { kind: "person", id: "ana" };
export const bob: Actor = { kind: "person", id: "bob" };
export const cy: Actor = { kind: "person", id: "cy" };

const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** What the tools answered, in order. */
export const outputs: string[] = [];

/** "tool <name> <json>" calls that tool; then it says "done". */
const script: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      outputs.push(text(last));
      yield { type: "text", text: "done" };
      return;
    }
    const said = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const asked = /tool (\w+)(?: (\{[\s\S]*\}))?\s*$/.exec(said);
    if (asked) {
      yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: asked[1], input: JSON.parse(asked[2] ?? "{}") },
      };
    } else yield { type: "text", text: `heard: ${said.slice(-40)}` };
  },
};

/** Reads boards and cards as an actor, under the rules: what they'd see. */
const peek = defineAction({
  input: { type: "object", properties: { in: { type: "string" } } },
  allow: () => true,
  run: async (ctx, input) => ({
    boards: await ctx.db.collection<Board>("board").find(input.in ? { in: input.in } : {}),
    cards: await ctx.db.collection<Card>("card").find(input.in ? { in: input.in } : {}),
  }),
});

export async function start(make: () => Store | Promise<Store>): Promise<Runtime> {
  outputs.length = 0;
  const agent = (name: string, isDefault: boolean) => ({
    name,
    icon: "🤖",
    instructions: `I am ${name}.`,
    model: "s/one",
    default: isDefault,
  });
  return await createRuntime({
    store: await make(),
    plugins: [
      models,
      chat,
      ...access,
      boards,
      definePlugin({
        name: "app",
        actions: { "test.peek": peek },
        resources: {
          shared: { thread: {}, message: { labels: true } },
          provider: { s: { adapter: "s" } },
          agents: {
            north: agent("North", true),
            south: agent("South", true),
            west: agent("West", false),
          },
        },
        adapters: { llm: { s: script } },
      }),
    ],
  });
}

/** What `actor` sees of boards and cards (in `space`, or everywhere). */
export const peekAs = (rt: Runtime, actor: Actor, space?: string) =>
  rt.call<{ boards: Board[]; cards: Card[] }>("test.peek", space ? { in: space } : {}, { actor });

/** Lets `who` into `space` as people join: their email, an invitation from `by`, accepted. */
export async function join(rt: Runtime, space: string, who: Actor, role: string, by: Actor) {
  const email = `${who.id}@example.com`;
  await rt.call("person.set", {
    person: who.id,
    email,
    name: who.id[0].toUpperCase() + who.id.slice(1),
  });
  const { invitation } = await rt.call<{ invitation: string }>("invitation.send", {
    space,
    email,
    role,
  }, { actor: by });
  await rt.call("invitation.accept", { invitation }, { actor: who });
}

/** The error a call fails with: its code and message. */
export async function failure(
  promise: Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  throw new Error("It didn't fail");
}
