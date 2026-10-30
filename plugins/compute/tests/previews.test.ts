/**
 * Previews: an agent makes an address for what its job serves; a member of
 * the space opens it, let in once through the app (a grant that becomes a
 * cookie for that host alone), and every request goes to the computer and
 * back, streamed; anyone opens a `link` one; nobody else gets in, and the
 * app only sends people back to paths on the preview. A sleeping computer
 * is woken for its preview.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type { WorkerWorkHandler } from "@oxian/oxian-js";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Plugin,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type ToolContext } from "../../agents/chat/mod.ts";
import { access, identity } from "../../access/mod.ts";
import { directory } from "../../access/directory/mod.ts";
import { join } from "../../access/tests/join.ts";
import { orgsHost } from "../../../hosts/orgs/mod.ts";
import { type Computer, computers, type Desk } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { type HttpRequestHead, type Job, WORK } from "../computers/shared/workloads.ts";
import { createTickets } from "../../../hosts/web/tickets.ts";
import { webServer } from "../../../hosts/web/server.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cy: Actor = { kind: "person", id: "cy" };
const eve: Actor = { kind: "person", id: "eve" };

const APP = "https://app.test";
const FRONT = { secret: "front-secret" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const job = (fields: Partial<Job> & { id: string; name: string }): Job => ({
  who: "agent:assistant",
  command: "npm run dev",
  pid: 1,
  running: true,
  exitCode: null,
  startedAt: "2026-10-30T00:00:00.000Z",
  ...fields,
});

const JOBS = [
  job({ id: "j1", name: "web", port: 5173 }),
  job({ id: "j2", name: "api", ports: [8080, 9090] }),
  job({ id: "j3", name: "watch" }),
];

/**
 * What the fake computer serves: its jobs, and HTTP that says what it was
 * asked (head and body), in two parts; `/stream` waits between them for the
 * test to say so, so its first part must arrive alone.
 */
function serving() {
  const heads: HttpRequestHead[] = [];
  let open = () => {};
  const gate = new Promise<void>((resolve) => open = resolve);
  const workloads: Record<string, WorkerWorkHandler> = {
    [WORK.jobsList]: async ({ input }) => {
      await new Response(input).text();
      return encoder.encode(JSON.stringify(JOBS));
    },
    [WORK.http]: async ({ input }) => {
      const bytes = new Uint8Array(await new Response(input).arrayBuffer());
      const newline = bytes.indexOf(10);
      const head = JSON.parse(decoder.decode(bytes.subarray(0, newline))) as HttpRequestHead;
      heads.push(head);
      // Work it can't do answers a failure, as the program does.
      if (head.path === "/fail") {
        return encoder.encode(JSON.stringify({ error: { message: "no port", code: "failed" } }));
      }
      const said = JSON.stringify({
        method: head.method,
        path: head.path,
        port: head.port,
        scope: head.scope,
        headers: Object.fromEntries(head.headers),
        body: decoder.decode(bytes.subarray(newline + 1)),
      });
      const parts = [said.slice(0, 20), said.slice(20)];
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(
            JSON.stringify({
              status: 200,
              headers: [
                ["content-type", "application/json"],
                ["x-echo", "yes"],
                ["connection", "keep-alive"],
                ["transfer-encoding", "chunked"],
                ["set-cookie", "a=1; Path=/"],
                ["set-cookie", "b=2; Path=/"],
              ],
            }) + "\n",
          ));
          controller.enqueue(encoder.encode(parts[0]));
          if (head.path === "/stream") await gate;
          controller.enqueue(encoder.encode(parts[1]));
          controller.close();
        },
      });
    },
  };
  return { workloads, heads, open };
}

/** A browser: its cookies by host, sent back to that host only. */
function browser(serve: (request: Request) => Promise<Response>) {
  const jars = new Map<string, Map<string, string>>();
  const set: string[] = [];
  const send = async (url: string, init: RequestInit = {}) => {
    const host = new URL(url).host;
    const jar = jars.get(host) ?? new Map<string, string>();
    jars.set(host, jar);
    const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
    const headers = new Headers(init.headers);
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    const response = await serve(new Request(url, { ...init, headers }));
    for (const line of response.headers.getSetCookie()) {
      set.push(line);
      const [pair] = line.split(";");
      jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
    return response;
  };
  return { send, jars, set };
}

/** Where a redirect sends the browser, absolute. */
const location = (response: Response, from: string) => {
  assertEquals(response.status, 302, `a redirect from ${from}`);
  return new URL(response.headers.get("location")!, from).href;
};

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300 && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

type World = {
  rt: Runtime;
  serve: (request: Request) => Promise<Response>;
  launch: string;
  thread: string;
  computer: ReturnType<typeof fakeComputer>;
  laptop: Computer;
  heads: HttpRequestHead[];
  open: () => void;
  topic: string;
  workloads: Record<string, WorkerWorkHandler>;
  signIn(who: Actor): Promise<ReturnType<typeof browser>>;
  tool(input: Record<string, unknown>, actor?: Actor): Promise<string>;
};

/**
 * Ana's computer, shared into Launch (Bob an editor, Cy a viewer; Eve in no
 * way), Bob's conversation there, and the web host serving it all.
 */
async function setup(fn: (world: World) => Promise<void>, more: Plugin[] = []) {
  const topic = `previews-test.${crypto.randomUUID()}`;
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      agents: {
        assistant: { instructions: "Hi.", model: "fake/echo", default: true, tools: ["preview"] },
      },
      computers: { previews: { domain: "preview.test", key: "the-key", app: APP } },
    },
    actions: {
      // A tool, as an agent's turn would run it.
      "test.tool": defineAction({
        input: {
          type: "object",
          properties: {
            tool: { type: "string" },
            thread: { type: "string" },
            input: { type: "object" },
          },
        },
        allow: () => true,
        run: (ctx, input) =>
          tools[input.tool!].run(input.input ?? {}, {
            ...ctx,
            agent: "assistant",
            thread: input.thread!,
            trigger: "test",
          } as ToolContext),
      }),
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app, ...more],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const { workloads, heads, open } = serving();
  try {
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const connected = fakeComputer(topic, `code:${code}`, { workloads });
    await connected.worker.ready;
    const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    await until(async () => (await mine())[0]?.online === true, "it came");
    const [laptop] = await mine();
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await join(rt, launch, bob, "editor", ana);
    await join(rt, launch, cy, "viewer", ana);
    await rt.call("person.set", { person: "eve", email: "eve@example.com" });
    await rt.call("computer.share", { computer: laptop._id, in: launch }, { actor: ana });
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: launch,
    }, { actor: bob });
    await rt.idle();
    const serve = webServer({
      runtime: rt,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "" } },
      upgrade: () => new Response("the app's socket", { status: 299 }),
      front: FRONT,
    });
    try {
      await fn({
        rt,
        serve,
        launch,
        thread,
        computer: connected,
        laptop,
        heads,
        open,
        topic,
        workloads,
        async signIn(who) {
          const { session } = await rt.call<{ session: string }>("session.start", {
            person: who.id,
          });
          const b = browser(serve);
          b.jars.set(new URL(APP).host, new Map([["session", session]]));
          return b;
        },
        tool: async (input, actor = bob) =>
          String(await rt.call("test.tool", { tool: "preview", thread, input }, { actor })),
      });
    } finally {
      await connected.worker.stop().catch(() => {});
    }
  } finally {
    await rt.close();
  }
}

/** The address a tool's answer gives. */
const urlIn = (said: string) => {
  const found = /https:\/\/[a-z0-9]{10}-preview\.preview\.test\//.exec(said);
  assert(found, `an address in: ${said}`);
  return found[0];
};

test("an agent previews its job; a member gets in through the app, and it streams both ways", async () => {
  await setup(async ({ rt, launch, heads, open, signIn, tool }) => {
    const said = await tool({ job: "web" });
    assertStringIncludes(said, "Only this space's members can open it");
    const url = urlIn(said);
    const host = new URL(url).host;
    // Bob sees it in Launch; Eve, in no way a member, doesn't.
    const listed = await rt.call<{ previews: { url: string; port: number; job?: string }[] }>(
      "computer.previews",
      { in: launch },
      { actor: bob },
    );
    assertEquals(listed.previews.map((p) => [p.url, p.port, p.job]), [[url, 5173, "j1"]]);
    assertEquals(
      (await rt.call<{ previews: unknown[] }>("computer.previews", { in: launch }, {
        actor: eve,
      })).previews,
      [],
    );

    // Bob opens it: to the app, which knows him, and back with a grant that becomes a cookie.
    const b = await signIn(bob);
    const first = `${url}app/page?x=1`;
    const toApp = location(await b.send(first), first);
    assertEquals(
      toApp,
      `${APP}/__copilotz/previews/grant?host=${host}&to=${encodeURIComponent("/app/page?x=1")}`,
    );
    const back = location(await b.send(toApp), toApp);
    assertMatch(back, new RegExp(`^https://${host}/__copilotz/grant\\?g=`));
    const landed = await b.send(back);
    assertEquals(location(landed, back), first);
    const cookie = b.set.find((line) => line.startsWith("cz_preview="))!;
    assertMatch(cookie, /; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=43200$/);
    assert(!/domain=/i.test(cookie), "host-only");
    // The grant was for the preview's host: the app's own jar has no cookie of it.
    assertEquals(b.jars.get("app.test")?.has("cz_preview"), false);

    // In: the computer is asked as Bob asked, without this connection's headers or the grant.
    const page = await b.send(first, {
      headers: {
        cookie: `theirs=1; cz_preview=${b.jars.get(host)!.get("cz_preview")}`,
        connection: "keep-alive, x-private",
        "x-private": "hop",
        "x-copilotz-front": FRONT.secret,
      },
    });
    assertEquals(page.status, 200);
    assertEquals(page.headers.get("x-echo"), "yes");
    assertEquals(page.headers.get("connection"), null);
    assertEquals(page.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
    const echoed = await page.json();
    assertEquals([echoed.method, echoed.path, echoed.port, echoed.body], [
      "GET",
      "/app/page?x=1",
      5173,
      "",
    ]);
    // Its job's: in Launch's folder, the agent's.
    assertEquals(echoed.scope, { space: launch, folder: "launch", who: "agent:assistant" });
    assertEquals(echoed.headers.cookie, "theirs=1");
    assertEquals(echoed.headers["x-forwarded-host"], host);
    assertEquals(echoed.headers["x-forwarded-proto"], "https");
    for (const gone of ["host", "connection", "x-private", "x-copilotz-front"]) {
      assertEquals(echoed.headers[gone], undefined, gone);
    }

    // A body goes as it is.
    const posted = await b.send(`${url}api/save`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello, computer",
    });
    assertEquals(
      [(await posted.json()).body, heads.at(-1)!.method],
      ["hello, computer", "POST"],
    );

    // An answer streams: its first part arrives before the computer has sent the rest.
    const streamed = await b.send(`${url}stream`);
    const reader = streamed.body!.getReader();
    let text = "";
    while (text.length < 20) text += decoder.decode((await reader.read()).value);
    assertEquals(text, '{"method":"GET","pat');
    open();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      text += decoder.decode(read.value);
    }
    assertEquals(JSON.parse(text).path, "/stream");

    // What the computer couldn't do, it says.
    const failed = await b.send(`${url}fail`);
    assertEquals([failed.status, await failed.text()], [
      502,
      "This preview's computer couldn't answer: no port",
    ]);

    // WebSockets aren't carried.
    const socket = await b.send(`${url}hmr`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    assertEquals(socket.status, 501);
    assertStringIncludes(await socket.text(), "WebSockets");
  });
});

test("who gets in: members, or anyone with a link one; and only to paths on the preview", async () => {
  await setup(async ({ rt, serve, launch, laptop, signIn, tool }) => {
    const url = urlIn(await tool({ job: "j1" }));
    const host = new URL(url).host;
    const grantFor = (h: string, to: string) =>
      `${APP}/__copilotz/previews/grant?host=${encodeURIComponent(h)}&to=${encodeURIComponent(to)}`;

    // Eve, signed in but no member, is refused; nobody signed in is asked to.
    const e = await signIn(eve);
    assertEquals(location(await e.send(url), url), grantFor(host, "/"));
    assertEquals((await e.send(grantFor(host, "/"))).status, 403);
    assertEquals((await browser(serve).send(grantFor(host, "/"))).status, 401);
    // A viewer of the space gets in.
    const c = await signIn(cy);
    const back = location(await c.send(grantFor(host, "/")), grantFor(host, "/"));
    assertEquals(location(await c.send(back), back), url);
    assertEquals((await c.send(url)).status, 200);

    // Only paths on the preview, and only a preview's host of this domain, get a grant.
    const b = await signIn(bob);
    for (const to of ["https://evil.test/", "//evil.test/", "/\\evil.test", "evil"]) {
      assertEquals((await b.send(grantFor(host, to))).status, 400, to);
    }
    for (const elsewhere of ["abcdefghij-preview.evil.test", "app.test", `x.${host}`]) {
      assertEquals((await b.send(grantFor(elsewhere, "/"))).status, 400, elsewhere);
    }
    const granted = location(await b.send(grantFor(host, "/")), grantFor(host, "/"));
    const g = new URL(granted).searchParams.get("g")!;
    const landing = (grant: string, to: string, at = host) =>
      `https://${at}/__copilotz/grant?g=${encodeURIComponent(grant)}&to=${encodeURIComponent(to)}`;
    assertEquals((await b.send(landing(g, "//evil.test/"))).status, 400);
    assertEquals((await b.send(landing(g.slice(0, -2) + "xx", "/"))).status, 403);

    // A grant, or a cookie, for one preview opens no other.
    const other = urlIn(await tool({ port: 3000 }));
    const otherHost = new URL(other).host;
    assertEquals((await b.send(landing(g, "/", otherHost))).status, 403);
    assertEquals(location(await b.send(granted), granted), url);
    const cookie = b.jars.get(host)!.get("cz_preview")!;
    const borrowed = await b.send(other, { headers: { cookie: `cz_preview=${cookie}` } });
    assertEquals(borrowed.status, 302);

    // Anyone with a link one's address opens it.
    const { url: open } = await rt.call<{ url: string }>("computer.preview", {
      in: launch,
      port: 4000,
      visibility: "link",
    }, { actor: ana });
    const anyone = await browser(serve).send(`${open}hi`);
    assertEquals([anyone.status, (await anyone.json()).port], [200, 4000]);

    // Ports: given, the job's, the first it listens on; else asked for.
    assertEquals(
      (await rt.call<{ previews: { port: number }[] }>("computer.previews", {
        in: launch,
      }, { actor: bob })).previews.map((p) => p.port).sort(),
      [3000, 4000, 5173],
    );
    const { label } = await rt.call<{ label: string }>("computer.preview", {
      in: launch,
      job: "api",
    }, { actor: bob });
    const api = await rt.call<{ previews: { _id: string; port: number }[] }>(
      "computer.previews",
      { in: launch },
      { actor: bob },
    );
    assertEquals(api.previews.find((p) => p._id === label)?.port, 8080);
    assertStringIncludes(await tool({ job: "watch" }), "says no port");
    assertStringIncludes(await tool({}), "Which port?");
    assertStringIncludes(await tool({ job: "nope" }), 'no job "nope"');
    // Only who may work in the space makes one.
    const refused = await rt.call("computer.preview", { in: launch, port: 1 }, { actor: eve })
      .then(() => "made", (error) => (error as { code?: string }).code);
    assertEquals(refused, "forbidden");

    // Taken away: by who made it (not a viewer), then it's gone.
    const asCy = await rt.call("computer.unpreview", { label }, { actor: cy })
      .then(() => "removed", (error) => (error as { code?: string }).code);
    assertEquals(asCy, "forbidden");
    await rt.call("computer.unpreview", { label: new URL(other).host.split(".")[0] }, {
      actor: bob,
    });
    assertEquals((await browser(serve).send(other)).status, 404);
    assertEquals(
      (await browser(serve).send("https://abcdefghij-preview.preview.test/")).status,
      404,
    );

    // Out of the space, its computer serves none of its previews.
    const [desk] = await rt.query<Desk[]>("desk.here", { in: launch }, { actor: ana });
    assertEquals(desk.computer, laptop._id);
    await rt.call("computer.unshare", { desk: desk._id }, { actor: ana });
    assertEquals((await browser(serve).send(`${open}hi`)).status, 404);
  });
});

test("a sleeping computer is woken for its preview, and kept awake; where many orgs, hosts are claimed", async () => {
  const woken: string[] = [];
  const touched: string[] = [];
  const claimed: string[] = [];
  const released: string[] = [];
  let wakeUp = () => {};
  const cloud = definePlugin({
    name: "cloud-test",
    resources: {
      computerWake: { wake: "test.wake", touch: "test.touch" },
      // As the orgs host gives an org's runtime.
      directory: {
        claimHost: (host: string) => Promise.resolve(void claimed.push(host)),
        releaseHost: (host: string) => Promise.resolve(void released.push(host)),
      },
    },
    actions: {
      "test.wake": defineAction({
        input: { type: "object", properties: { computer: { type: "string" } } },
        run: (_ctx, input) => {
          woken.push(input.computer!);
          wakeUp();
          return {};
        },
      }),
      "test.touch": defineAction({
        input: { type: "object", properties: { computer: { type: "string" } } },
        run: (_ctx, input) => void touched.push(input.computer!),
      }),
    },
  });
  await setup(async ({ rt, serve, launch, laptop, computer, topic, workloads }) => {
    const { url, label } = await rt.call<{ url: string; label: string }>("computer.preview", {
      in: launch,
      port: 3000,
      visibility: "link",
    }, { actor: ana });
    assertEquals(claimed, [`${label}.preview.test`]);

    // Asleep: the request wakes it, then it's served.
    await computer.worker.stop();
    const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    await until(async () => (await mine())[0]?.online === false, "it slept");
    let again: ReturnType<typeof fakeComputer> | undefined;
    wakeUp = () => {
      again = fakeComputer(topic, computer.credential(), { workloads });
    };
    try {
      const answered = await browser(serve).send(`${url}woke`);
      assertEquals([answered.status, (await answered.json()).path], [200, "/woke"]);
      assertEquals(woken, [laptop._id]);
      // Each request keeps it awake (said at most every few seconds).
      await browser(serve).send(`${url}again`).then((r) => r.body?.cancel());
      await until(() => Promise.resolve(touched.length > 0), "touched");
      assertEquals(touched, [laptop._id]);
    } finally {
      await again?.worker.stop().catch(() => {});
    }

    await rt.call("computer.unpreview", { label }, { actor: ana });
    assertEquals(released, [`${label}.preview.test`]);
  }, [cloud]);
});

test("where many orgs are served: the preview's host is the org's, and the grant is under its address", async () => {
  const topic = `previews-orgs.${crypto.randomUUID()}`;
  const dir = await createRuntime({ store: memoryStore(), plugins: [identity, directory] });
  const host = orgsHost({
    directory: dir,
    hosts: ["localhost"],
    open: async (_org, given) =>
      await createRuntime({
        store: memoryStore(),
        plugins: [
          models,
          chat,
          ...access,
          computers,
          ...given.plugins,
          definePlugin({
            name: "app",
            resources: {
              computers: {
                previews: { domain: "preview.test", key: "the-key", app: "http://localhost" },
              },
            },
          }),
        ],
        admit: given.admit,
        transports: [{ type: "in-process", config: { topic } }],
      }),
    upgrade: () => new Response(null, { status: 299 }),
    code: { entry: "app.js", files: { "app.js": "" } },
    dev: true,
  });
  const { workloads } = serving();
  let computer: ReturnType<typeof fakeComputer> | undefined;
  try {
    const a = browser(host.serve);
    const signed = await (await a.send("http://localhost/signin/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ana" }),
    })).json();
    const org: string = signed.org.id;
    const rt = (await host.runtime(org)) as Runtime;
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    computer = fakeComputer(topic, `code:${code}`, { workloads });
    await computer.worker.ready;
    await until(
      async () => (await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0]?.online,
      "it came",
    );
    const { url, label } = await rt.call<{ url: string; label: string }>("computer.preview", {
      port: 3000,
    }, { actor: ana });
    const previewHost = `${label}.preview.test`;
    assertEquals(await dir.query("orgHost.resolve", { host: previewHost }), { org });

    // To the org's own address on the app, which knows her there, and back.
    const toApp = location(await a.send(url), url);
    assertEquals(
      toApp,
      `http://localhost/o/${org}/__copilotz/previews/grant?host=${previewHost}&to=%2F`,
    );
    const back = location(await a.send(toApp), toApp);
    assertEquals(location(await a.send(back), back), url);
    const page = await a.send(`${url}hello`);
    assertEquals([page.status, (await page.json()).port], [200, 3000]);

    // Someone signed in elsewhere, with no session in this org, isn't let in.
    const e = browser(host.serve);
    await e.send("http://localhost/signin/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "eve" }),
    });
    assertEquals((await e.send(toApp)).status, 401);
    // A preview host nobody claimed is nobody's.
    assertEquals((await e.send("https://abcdefghij-preview.preview.test/")).status, 404);
    // Taken away, its host is released.
    await rt.call("computer.unpreview", { label }, { actor: ana });
    assertEquals(await dir.query("orgHost.resolve", { host: previewHost }), null);
    assertEquals((await a.send(`${url}hello`)).status, 404);
  } finally {
    await computer?.worker.stop().catch(() => {});
    await host.close();
    await dir.close();
  }
});

test("without a wake hook, an offline computer's preview says so", async () => {
  await setup(async ({ rt, serve, launch, computer }) => {
    const { url } = await rt.call<{ url: string }>("computer.preview", {
      in: launch,
      port: 3000,
      visibility: "link",
    }, { actor: ana });
    await computer.worker.stop();
    const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    await until(async () => (await mine())[0]?.online === false, "it went");
    const answered = await browser(serve).send(url);
    assertEquals(answered.status, 503);
    assertStringIncludes(await answered.text(), "offline");
  });
});
