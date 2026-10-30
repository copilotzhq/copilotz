/**
 * Chat's terminal commands: plain text talks (`@name` addresses agents; when
 * an agent is waiting on your answer, your next message is it), and commands
 * move between conversations, fork them and show what agents are sent.
 * Where you are is your shell state: the open conversation is `open`, kind
 * `thread`, and the screen shows it through chat's `thread` View.
 */
import { command, type Commands, dim, type Terminal } from "../../../../hosts/terminal/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Agent, Prompt } from "../shared/types.ts";
import type { Listed } from "../views/terminal/threads.ts";

/** The open conversation, if one is. */
const thread = async (term: Terminal) => {
  const { open } = await term.state();
  return open?.kind === "thread" ? open.item._id as string : undefined;
};
const go = (term: Terminal, id: string) =>
  term.set({ open: { kind: "thread", item: { _id: id } } });
const none = (term: Terminal) => term.print(dim("No conversation yet."));

/** This conversation's shared messages, inherited ones included, numbered as /history numbers them. */
const numbered = async (term: Terminal, here: string) =>
  (await term.runtime.query<Message[]>("message.history", { thread: here, lineage: true }))
    .filter((m) => !m.toolCalls);

/** A file's media type, by its extension. */
const TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  ts: "text/typescript",
  js: "text/javascript",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};
const typeOf = (name: string) =>
  TYPES[name.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream";

/** Sends with its own call id, retrying once with it if the executor is lost mid-send. */
async function send(term: Terminal, input: Record<string, unknown>) {
  const id = crypto.randomUUID();
  const call = () => term.runtime.call<{ thread: string }>("chat.send", input, { id });
  try {
    return await call();
  } catch (error) {
    if ((error as { code?: string }).code !== "executor_lost") throw error;
    await term.print(dim("The executor was lost mid-send; retrying with the same id…"));
    return await call();
  }
}

/** Forks at a message (in whichever thread of the lineage holds it) and moves there. */
async function fork(term: Terminal, m: Message, again = false) {
  const forked = await term.runtime.call<{ thread: string }>("chat.fork", {
    thread: m.thread,
    message: m._id,
    again,
  });
  await go(term, forked.thread);
  return forked.thread;
}

export const commands: Commands = {
  "*": command({
    description: "Talk: @name addresses agents; a question you were asked takes your answer",
    async run(text, term) {
      const state = await term.state();
      const here = state.open?.kind === "thread" ? state.open.item._id as string : undefined;
      const [asked] = await term.runtime.query<Message[]>("message.questions", { person: term.me });
      const sent = await send(
        term,
        asked
          ? { thread: asked.thread, text, from: term.me, replyTo: asked._id }
          : here
          ? { thread: here, text, from: term.me }
          // A new conversation goes where you work.
          : { text, from: term.me, ...(state.space ? { in: state.space } : {}) },
      );
      if (!asked && sent.thread !== here) await go(term, sent.thread);
      await term.runtime.idle();
    },
  }),
  "/stop": command({
    description: "Stop the agents working here (and in its subthreads)",
    key: "escape",
    async run(_, term) {
      const here = await thread(term);
      if (!here) return;
      const { stopped } = await term.runtime.call<{ stopped: number }>("chat.stop", {
        thread: here,
      });
      if (!stopped) await term.print(dim("Nothing to stop."));
    },
  }),
  "/file": command({
    description: "Send a file (its text, for text files), with what you say about it",
    usage: "<path> [message]",
    async run(rest, term) {
      const [path, ...words] = rest.split(" ").filter(Boolean);
      if (!path) return await term.print(dim("Usage: /file <path> [message]"));
      const { readFile } = await import("node:fs/promises");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(path));
      } catch {
        return await term.print(dim(`Can't read ${path}.`));
      }
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const name = path.split("/").at(-1)!;
      const state = await term.state();
      const here = state.open?.kind === "thread" ? state.open.item._id as string : undefined;
      const sent = await send(term, {
        text: words.join(" ") || `Here's ${name}.`,
        from: term.me,
        files: [{ name, type: typeOf(name), data: btoa(binary) }],
        ...(here ? { thread: here } : state.space ? { in: state.space } : {}),
      });
      if (sent.thread !== here) await go(term, sent.thread);
      await term.runtime.idle();
    },
  }),
  "/share": command({
    description: "Show everyone here the latest answer only some of them can see",
    async run(_, term) {
      const here = await thread(term);
      if (!here) return await none(term);
      const said = await term.runtime.query<Message[]>("message.history", { thread: here });
      const labelled = said.findLast((m) => m.sources?.length);
      if (!labelled) return await term.print(dim("Everyone here sees everything already."));
      await term.runtime.call("share", { collection: "message", id: labelled._id });
      const spaces = await term.runtime.query<{ _id: string; name: string }[]>("space.reached", {});
      const names = labelled.sources!.map((id) => spaces.find((p) => p._id === id)?.name ?? id);
      await term.print(dim(`Shared: everyone here sees what came from ${names.join(", ")}.`));
    },
  }),
  "/move": command({
    description: "Move this conversation, with everything in it, to another space you work in",
    usage: "<space>",
    async run(rest, term) {
      const here = await thread(term);
      if (!here) return await none(term);
      const spaces = await term.runtime.query<{ _id: string; name: string }[]>("space.reached", {});
      const name = rest.trim().toLowerCase();
      const to = spaces.find((p) => p._id === rest.trim() || p.name.toLowerCase() === name);
      if (!to) return await term.print(dim("Usage: /move <space>, one /spaces lists."));
      await term.runtime.call("chat.move", { thread: here, to: to._id });
      // You go with it: new conversations go there too.
      await term.set({ space: to._id });
      await term.print(dim(`Moved to ${to.name}: its members see this conversation now.`));
    },
  }),
  "/new": command({
    description: "Start a new conversation",
    async run(_, term) {
      await term.set({ open: null });
      await term.print(dim("New conversation."));
    },
  }),
  "/threads": command({
    description: "The latest conversations",
    async run(_, term) {
      const threads = await term.runtime.query<Listed[]>("thread.recent", {});
      await term.set({ listed: threads.map((t) => t._id) });
      if (!threads.length) {
        return await term.print(
          dim("No conversations you can see yet: yours, or in spaces you're a member of."),
        );
      }
      const open = await thread(term);
      await term.show("threads", { threads, ...(open ? { open } : {}) });
      await term.print(dim("/open <n> continues one."));
    },
  }),
  "/open": command({
    description: "Continue a conversation, by number or id",
    usage: "<n|id>",
    async run(rest, term) {
      const listed = (await term.state()).listed ?? [];
      const all = await term.runtime.query<Listed[]>("thread.recent", { limit: 1000 });
      const id = listed[Number(rest) - 1] ??
        all.find((t) => rest && t._id.startsWith(rest))?._id;
      if (!id) return await term.print(dim("No such conversation; /threads lists them."));
      await go(term, id);
      await term.print(dim(`Continuing ${id.slice(0, 8)}.`));
    },
  }),
  "/history": command({
    description: "This conversation, with agents' steps; shared messages are numbered",
    async run(_, term) {
      const here = await thread(term);
      if (!here) return await none(term);
      const messages = await term.runtime.query<Message[]>("message.history", {
        thread: here,
        lineage: true,
      });
      let n = 0;
      for (const m of messages) {
        await term.show("message", m, { thread: here, ...(m.toolCalls ? {} : { n: ++n }) });
      }
    },
  }),
  "/fork": command({
    description: "Continue from message n in a fork, to say something else there",
    usage: "[n]",
    async run(rest, term) {
      const here = await thread(term);
      if (!here) return await none(term);
      const messages = await numbered(term, here);
      const m = messages[(Number(rest) || messages.length) - 1];
      if (!m) return await term.print(dim("No such message; /history numbers them."));
      const id = await fork(term, m);
      await term.print(
        dim(`Forked at [${messages.indexOf(m) + 1}] into ${id.slice(0, 8)}; you're there now.`),
      );
    },
  }),
  "/retry": command({
    description: "Have your last message answered again, in a fork",
    async run(_, term) {
      const here = await thread(term);
      const mine = here
        ? (await numbered(term, here)).findLast((m) => m.from === term.me)
        : undefined;
      if (!mine) return await term.print(dim("Nothing of yours to answer again yet."));
      const id = await fork(term, mine, true);
      await term.print(dim(`Answering your last message again, in a fork (${id.slice(0, 8)}).`));
      await term.runtime.idle();
    },
  }),
  "/prompt": command({
    description: "Exactly what an agent would be sent now",
    usage: "[agent]",
    async run(rest, term) {
      const here = await thread(term);
      if (!here) return await none(term);
      const agents = (term.runtime.describe().resources.agents ?? {}) as Record<string, Agent>;
      const agent = rest || Object.keys(agents).find((name) => agents[name].default) ||
        Object.keys(agents)[0];
      const prompt = await term.runtime.query<Prompt | null>("thread.prompt", {
        thread: here,
        agent,
      });
      if (!prompt) return await term.print(dim("No such conversation."));
      await term.show("agent.prompt", { ...prompt, agent });
    },
  }),
};
