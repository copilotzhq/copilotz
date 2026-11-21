/**
 * Files between a chat and a computer, and onto a computer from a browser:
 * an agent is told each file's id, saves a file sent in its chat into the
 * space's folder (`save_file`), and sends one from the folder into the chat
 * (`send_file`, once however often it runs); a person puts a file on a
 * space's computer (`PUT /computers/upload`), streamed through as it comes,
 * only where they may change it, and a program from before uploads is told
 * apart.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type Message, type Prompt, type ToolContext } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { attached } from "../../agents/tests/fixtures/files.ts";
import { type Computer, computers, type Desk } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { type FilesPutHead, WORK } from "../computers/shared/workloads.ts";
import { splitHead } from "../computers/program/workloads/streams.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const APP = "https://app.test";

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const app = definePlugin({
  name: "app",
  resources: {
    shared: { thread: {}, message: {}, file: {} },
    agents: {
      assistant: {
        instructions: "Hi.",
        model: "fake/echo",
        default: true,
        tools: ["save_file", "send_file"],
      },
    },
  },
  actions: {
    // A tool, as an agent's turn would run it: where its chat is, with its call's id.
    "test.tool": defineAction({
      input: {
        type: "object",
        properties: {
          tool: { type: "string" },
          thread: { type: "string" },
          input: { type: "object" },
          call: { type: "string" },
        },
      },
      allow: () => true,
      run: async (ctx, input) =>
        tools[input.tool!].run(input.input ?? {}, {
          ...await ctx.as().db.collection<{ in?: string }>("thread")
            .findOne({ _id: input.thread! })
            .then((t) => t?.in ? ctx.as({ ...ctx.actor!, in: t.in }) : ctx),
          agent: "assistant",
          thread: input.thread!,
          trigger: "test",
          callId: input.call ?? "call-1",
        } as ToolContext),
    }),
  },
});

type World = {
  rt: Awaited<ReturnType<typeof createRuntime>>;
  space: string;
  thread: string;
  desk: Desk;
  /** What the computer was asked, in order. */
  asked: { work: string; input: Record<string, unknown> }[];
  /** Files put on it: their heads, and the bytes that came. */
  puts: { head: FilesPutHead; bytes: Uint8Array }[];
  tool(name: string, input: Record<string, unknown>, call?: string): Promise<unknown>;
  /** A PUT to the upload route, as Ana's browser (or `who`'s) sends it. */
  upload(query: Record<string, string>, body: Uint8Array, more?: {
    who?: Actor;
    headers?: Record<string, string>;
  }): Promise<Response>;
};

/**
 * Ana's Personal space, a computer the app made for her there (asking
 * nothing first, as a cloud computer), her chat with the assistant, and the
 * computer's answers: `files` as its folder holds them, read in parts.
 */
async function setup(
  fn: (world: World) => Promise<void>,
  options: { files?: Record<string, Uint8Array>; uploads?: boolean } = {},
) {
  const topic = `files-chat-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const puts: World["puts"] = [];
  /** Files in place on the computer, by path. */
  const written = new Set<string>();
  const files = options.files ?? {};
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await rt.idle();
    const { id } = await rt.call<{ id: string }>("computer.provision", {
      owner: "ana",
      name: "cloudbox",
      approve: [],
    });
    const { code } = await rt.call<{ code: string }>("computer.enrollment", { computer: id });
    const computer = fakeComputer(topic, `code:${code}`, {
      workloads: {
        // Its folder's files, read a part at a time (two bytes, so parts are gone through).
        [WORK.filesRead]: async ({ input }) => {
          const given = JSON.parse(await new Response(input).text());
          const bytes = files[given.path];
          if (!bytes) {
            return json({ error: { message: `No such file: ${given.path}`, code: "not_found" } });
          }
          const offset = given.offset ?? 0;
          const part = bytes.subarray(offset, offset + Math.min(given.length ?? 2, 2));
          return json({
            content: base64(part),
            encoding: "base64",
            size: bytes.length,
            truncated: offset + part.length < bytes.length,
          });
        },
        ...(options.uploads === false ? {} : {
          [WORK.filesPut]: async ({ input }) => {
            const { head, rest } = await splitHead(input);
            const bytes = new Uint8Array(await new Response(rest).arrayBuffer());
            const put = head as FilesPutHead;
            // There already, as the program asks: at a file's first part, and at its last.
            const { upload: part } = put;
            const edge = !part || part.offset === 0 || part.offset + bytes.length === part.total;
            if (edge && written.has(put.path) && !put.replace) {
              return json({ error: { message: `${put.path} is there already`, code: "exists" } });
            }
            puts.push({ head: put, bytes });
            if (!part || part.offset + bytes.length === part.total) written.add(put.path);
            // A part before the last says how much is in; the last, the file.
            const { upload } = put;
            if (upload && upload.offset + bytes.length < upload.total) {
              return json({ received: upload.offset + bytes.length });
            }
            return json({ path: put.path, size: upload?.total ?? bytes.length });
          },
        }),
      },
    });
    await computer.worker.ready;
    const online = async () =>
      (await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0]?.online === true;
    for (let i = 0; i < 300 && !await online(); i++) await new Promise((r) => setTimeout(r, 10));
    const [desk] = await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
    try {
      await fn({
        rt,
        space,
        thread,
        desk,
        asked: computer.asked,
        puts,
        tool: (name, input, call) =>
          rt.call("test.tool", { tool: name, thread, input, ...(call ? { call } : {}) }, {
            actor: ana,
          }),
        async upload(query, body, more = {}) {
          const { session } = await rt.call<{ session: string }>("session.start", {
            person: (more.who ?? ana).id,
          });
          return await rt.fetch(
            new Request(`${APP}/computers/upload?${new URLSearchParams(query)}`, {
              method: "PUT",
              headers: {
                cookie: `__Host-session=${session}`,
                origin: APP,
                "content-length": String(body.length),
                ...more.headers,
              },
              body: body as Uint8Array<ArrayBuffer>,
            }),
          );
        },
      });
    } finally {
      await computer.worker.stop().catch(() => {});
    }
  } finally {
    await rt.close();
  }
}

test("an agent is told each file's id, and saves one sent in its chat into the space's folder", async () => {
  await setup(async ({ rt, space, thread, asked, tool }) => {
    const zip = new Uint8Array([80, 75, 3, 4, 0, 255, 1, 2]);
    const [sent] = await attached(rt, [{
      name: "data.zip",
      type: "application/zip",
      data: base64(zip),
    }], { actor: ana });
    await rt.call("chat.send", { thread, text: "use this", files: [sent], in: space }, {
      actor: ana,
    });
    await rt.idle();
    // The agent reads its name, kind, size and id.
    const prompt = await rt.query<Prompt>("thread.prompt", { thread, agent: "assistant" }, {
      actor: ana,
    });
    assertStringIncludes(
      JSON.stringify(prompt.history),
      `[file data.zip: application/zip, 8 bytes, id ${sent.id}]`,
    );

    // Saved where it's asked (or by its name), as base64, its bytes whole.
    const saved = await tool("save_file", { file: sent.id }) as Record<string, unknown>;
    assertEquals(saved.file, "data.zip");
    const write = asked.findLast((a) => a.work === WORK.filesWrite)!;
    assertEquals([write.input.path, write.input.encoding, write.input.content], [
      "data.zip",
      "base64",
      base64(zip),
    ]);
    await tool("save_file", { file: sent.id, path: "work/input.zip" });
    assertEquals(asked.findLast((a) => a.work === WORK.filesWrite)!.input.path, "work/input.zip");

    // A file nobody sent here, or someone's draft not sent yet, isn't there for it.
    assertStringIncludes(
      String(await tool("save_file", { file: "file-nope" })),
      "Error: there's no file",
    );
    const [draft] = await attached(rt, [{ name: "x.txt", data: btoa("x") }], { actor: ana });
    assertStringIncludes(
      String(await tool("save_file", { file: draft.id })),
      "Error: there's no file",
    );
  });
});

test("an agent sends a file from the folder into the chat, read in parts, said once", async () => {
  const report = encoder.encode("%PDF-1.7 a report");
  await setup(async ({ rt, thread, tool }) => {
    const answer = await tool("send_file", { path: "out/report.pdf", text: "Here it is." }) as {
      sent: string;
      size: number;
    };
    assertEquals([answer.sent, answer.size], ["report.pdf", report.length]);
    // Run again as itself (a retried turn), it says nothing more.
    await tool("send_file", { path: "out/report.pdf", text: "Here it is." });
    await rt.idle();
    const messages = (await rt.query<Message[]>("message.history", { thread }, { actor: ana }))
      .filter((m) => m.from === "assistant" && m.files?.length);
    assertEquals(messages.length, 1);
    const [message] = messages;
    assertEquals(message.text, "Here it is.");
    assertEquals(message.files!.map((f) => [f.name, f.type, f.size]), [[
      "report.pdf",
      "application/pdf",
      report.length,
    ]]);
    // Its people open it whole, as the chat serves files.
    const { session } = await rt.call<{ session: string }>("session.start", { person: "ana" });
    const served = await rt.fetch(
      new Request(`${APP}/files/${message.files![0].id}`, {
        headers: { cookie: `__Host-session=${session}` },
      }),
    );
    assertEquals(served.status, 200);
    assertEquals(new Uint8Array(await served.arrayBuffer()), report);

    // Not there: it says so, as the computer's other tools do, and nothing is sent.
    assertStringIncludes(
      JSON.stringify(await tool("send_file", { path: "nope.txt" }, "call-2")),
      "No such file",
    );
  }, { files: { "out/report.pdf": report } });
});

test("a file too large for a chat isn't sent, and the agent is told what to do instead", async () => {
  // Its size, as the computer says it, past a chat file's: refused at the first part.
  await setup(async ({ tool }) => {
    const said = String(await tool("send_file", { path: "huge.bin" }));
    assertStringIncludes(said, "Error: huge.bin is 12.0 MB");
    assertStringIncludes(said, "at most");
  }, { files: { "huge.bin": new Uint8Array(12_000_000) } });
});

test("a person puts a file on a space's computer: streamed through, kept unless replaced", async () => {
  await setup(async ({ desk, puts, upload }) => {
    const bytes = new Uint8Array(700 * 1024).map((_, i) => i % 251);
    const done = await upload({ desk: desk._id, path: "data/big.bin" }, bytes);
    assertEquals(done.status, 200);
    assertEquals(await done.json(), { path: "data/big.bin", size: bytes.length });
    assertEquals(puts.length, 1);
    assertEquals([puts[0].head.path, puts[0].head.size, puts[0].head.scope.folder], [
      "data/big.bin",
      bytes.length,
      desk.folder,
    ]);
    assertEquals(puts[0].bytes, bytes);
    assertEquals(puts[0].head.scope.who, "person:ana");

    // There already: 409, until it's replaced.
    const again = await upload({ desk: desk._id, path: "data/big.bin" }, new Uint8Array([1]));
    assertEquals([again.status, (await again.json()).error.code], [409, "exists"]);
    const replaced = await upload(
      { desk: desk._id, path: "data/big.bin", replace: "1" },
      new Uint8Array([1]),
    );
    assertEquals(replaced.status, 200);
    assertEquals(puts.at(-1)!.head.replace, true);
  });
});

test("only someone who may change a computer puts files on it, and only from the app's own page", async () => {
  await setup(async ({ desk, puts, upload }) => {
    // Bob isn't in Ana's space: there's no such computer, for him.
    const bobs = await upload({ desk: desk._id, path: "x" }, new Uint8Array([1]), { who: bob });
    assertEquals([bobs.status, (await bobs.json()).error.code], [404, "not_found"]);
    // From another site: refused before it gets anywhere.
    const elsewhere = await upload({ desk: desk._id, path: "x" }, new Uint8Array([1]), {
      headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    });
    assertEquals(elsewhere.status, 403);
    // Without where, or its size: refused plainly.
    const nowhere = await upload({ desk: desk._id }, new Uint8Array([1]));
    assertEquals([nowhere.status, (await nowhere.json()).error.code], [400, "invalid"]);
    assertEquals(puts.length, 0);
  });
});

test("a computer whose program takes no uploads yet is told apart: it needs updating", async () => {
  await setup(async ({ desk, upload }) => {
    const answer = await upload({ desk: desk._id, path: "a.txt" }, encoder.encode("hi"));
    assertEquals(answer.status, 501);
    assertEquals((await answer.json()).error.code, "outdated");
  }, { uploads: false });
});

test("a file in parts: each part goes through as it came, the computer asked what it serves once", async () => {
  await setup(async ({ desk, puts, asked, upload }) => {
    const query = (offset: number) => ({
      desk: desk._id,
      path: "big.zip",
      upload: "u-0001-abcd",
      offset: String(offset),
      total: "10",
    });
    const infos = () => asked.filter((a) => a.work === WORK.info).length;
    const before = infos();
    const first = await upload(query(0), new Uint8Array([0, 1, 2, 3]));
    assertEquals(await first.json(), { received: 4 });
    const second = await upload(query(4), new Uint8Array([4, 5, 6, 7]));
    assertEquals(await second.json(), { received: 8 });
    const last = await upload(query(8), new Uint8Array([8, 9]));
    assertEquals(await last.json(), { path: "big.zip", size: 10 });
    assertEquals(puts.map((p) => [p.head.upload?.offset, p.head.size]), [[0, 4], [4, 4], [8, 2]]);
    assert(puts.every((p) => p.head.upload?.id === "u-0001-abcd" && p.head.upload.total === 10));
    assertEquals(infos() - before, 1, "asked what it serves at the first part only");

    // A whole past 2 GiB is refused before anything goes, whatever its parts' sizes.
    const huge = await upload({ ...query(0), total: String(3 * 1024 ** 3) }, new Uint8Array([1]));
    assertEquals([huge.status, (await huge.json()).error.code], [413, "too_large"]);
  });
});
