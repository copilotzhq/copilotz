/**
 * When to notify: only when something waits on a person, and no tab of
 * theirs shows the app.
 *
 * - **An agent asks for their yes** (an `approval` they answer): "<agent>
 *   asks for your yes", with what it would do.
 * - **A message to them** (in its `to`): an agent's reply in a chat they
 *   left (its answer is to whoever wrote last), a person writing to them, a
 *   mention. Never their own, an agent's private step, or what stands where
 *   a reply went elsewhere (it says nothing).
 *
 * Tapping one opens its chat; another from the same chat replaces it on the
 * device (its tag). Added to an app, they start at the log's end, and skip
 * what's older than a few minutes (after downtime, late news is noise).
 * Each runs on the plugin's own grant: whoever's event it is, it reads the
 * devices and the tabs, which no actor reads.
 */
import type { Context, Event, ProcessorDef } from "../../../../runtime/mod.ts";
import { namesFor } from "../../../access/spaces/contract.ts";
import { chatUrl, deliver, gist, looking } from "../shared/deliver.ts";

/** Older than this, an event's notification is too late to send. */
const FRESH = 5 * 60_000;

const fresh = (event: Event) => Date.now() - Date.parse(String(event.at ?? "")) < FRESH;

async function nameOf(ctx: Context, id: string): Promise<string> {
  try {
    return (await namesFor(ctx.as(), [id]))[id] ?? id;
  } catch {
    return id;
  }
}

type Ask = {
  owner?: string;
  agent?: string;
  thread?: string;
  in?: string;
  text?: string;
  detail?: string;
  answer?: unknown;
};

export const askedProcessor: ProcessorDef = {
  on: "approval.created",
  as: "push",
  start: "now",
  run: async (ctx, event) => {
    const ask = (event.data as { doc?: Ask }).doc;
    if (!ask?.owner || !ask.thread || !fresh(event)) return;
    if (await looking(ctx, ask.owner)) return;
    const agent = ask.agent ? await nameOf(ctx, ask.agent) : undefined;
    await deliver(ctx, ask.owner, {
      title: agent ? `${agent} asks for your yes` : "An agent asks for your yes",
      body: gist(ask.text ?? ask.detail),
      url: chatUrl(ask.thread, ask.in),
      tag: `ask:${ask.thread}`,
    }, 3600);
  },
};

type Said = {
  thread?: string;
  in?: string;
  from?: string;
  to?: string[];
  text?: string;
  private?: boolean;
  files?: { name: string }[];
};

export const messageProcessor: ProcessorDef = {
  on: "message.created",
  where: { "doc.private": { $ne: true }, "doc.to.0": { $exists: true } },
  as: "push",
  start: "now",
  key: (event) => String((event.data as { doc?: Said }).doc?.thread ?? ""),
  run: async (ctx, event) => {
    const m = (event.data as { doc?: Said }).doc;
    if (!m?.thread || !m.from || !m.to?.length || m.private || !fresh(event)) return;
    const words = gist(m.text) || m.files?.map((f) => f.name).join(", ");
    if (!words) return;
    const sender = await nameOf(ctx, m.from);
    for (const person of new Set(m.to)) {
      if (person === m.from || await looking(ctx, person)) continue;
      await deliver(ctx, person, {
        title: sender,
        body: words,
        url: chatUrl(m.thread, m.in),
        tag: `chat:${m.thread}`,
      });
    }
  },
};
