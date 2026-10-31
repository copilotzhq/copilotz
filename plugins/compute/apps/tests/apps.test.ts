/**
 * Apps: a person publishes what a job on their space's computer serves; it
 * answers at once, building, and goes live at its host, which the directory
 * routes to its target; the build is metered. An agent's publish waits for
 * its person's yes, always. Failures leave the app failed, saying why.
 * Taking an app down removes it at the host and lets its host go. Labels
 * are DNS-safe and unique.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../models/mod.ts";
import { chat, type ToolContext } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { join } from "../../../access/tests/join.ts";
import usage from "../../../billing/usage/mod.ts";
import { type Approval, type Computer, computers } from "../../mod.ts";
import { tools as computerTools } from "../../computers/resources/tools.ts";
import { WORK } from "../../computers/shared/workloads.ts";
import { test } from "../../../../testing/mod.ts";
import { type AppDoc, type AppHost, apps } from "../mod.ts";
import { tools as appTools } from "../resources/tools.ts";
import { entries } from "../adapters/tar.ts";
import { kept, slugOf, suffixed } from "../shared/label.ts";
import { archivingComputer } from "./computer.ts";
import { tgz } from "./tgz.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const cy: Actor = { kind: "person", id: "cy" };

type Published = { app: string; url: string; status: string };

/**
 * An app host that builds nothing: it reads what it's sent, and says what it
 * did; its builds fail with `state.fail` while it's set.
 */
function fakeHost(options: { failBuild?: string } = {}) {
  const calls: Record<string, unknown>[] = [];
  const state = { fail: options.failBuild };
  let revisions = 0;
  const host: AppHost = {
    async build({ app, archive, command, port }) {
      const files: string[] = [];
      for await (const entry of entries(archive)) files.push(entry.name);
      calls.push({ op: "build", app, command, port, files });
      if (state.fail) throw Object.assign(new Error(state.fail), { minutes: 1 });
      return { image: `fake/${app}:${revisions + 1}`, minutes: 2 };
    },
    deploy({ app, image, port, env }) {
      calls.push({
        op: "deploy",
        app,
        image,
        port,
        ...(env && Object.keys(env).length ? { env } : {}),
      });
      const revision = `${app}-${String(++revisions).padStart(5, "0")}`;
      return Promise.resolve({
        service: `svc/${app}`,
        target: `https://${app}-abc.a.run.app`,
        revision,
      });
    },
    remove(app) {
      calls.push({ op: "remove", app });
      return Promise.resolve();
    },
    usage(app, from, to) {
      calls.push({ op: "usage", app, from, to });
      return Promise.resolve({ vcpuSeconds: 10, gibSeconds: 5, requests: 7 });
    },
  };
  return { host, calls, state };
}

/** The directory's hosts, as an org's runtime reaches them; `taken`: other orgs' already. */
function fakeDirectory(taken: string[] = []) {
  const claims = new Map<string, string | null>();
  const said: [string, string | undefined][] = [];
  const released: string[] = [];
  const resource = {
    claimHost: (host: string, options?: { target?: string }) => {
      said.push([host, options?.target]);
      if (taken.includes(host)) {
        return Promise.reject(
          Object.assign(new Error(`${host} is another org's`), { code: "forbidden" }),
        );
      }
      claims.set(host, options?.target ?? null);
      return Promise.resolve();
    },
    releaseHost: (host: string) => {
      claims.delete(host);
      released.push(host);
      return Promise.resolve();
    },
  };
  return { claims, said, released, resource };
}

const testPlugin = (
  host: AppHost,
  directory: ReturnType<typeof fakeDirectory>,
  computersSettings?: Record<string, unknown>,
) =>
  definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      agents: {
        assistant: {
          instructions: "Hi.",
          model: "fake/echo",
          default: true,
          tools: ["terminal", "publish"],
        },
      },
      directory: directory.resource,
      ...(computersSettings ? { computers: computersSettings } : {}),
    },
    adapters: { appHost: { local: host } },
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
          ({ ...computerTools, ...appTools })[input.tool!].run(input.input ?? {}, {
            ...ctx,
            agent: "assistant",
            thread: input.thread!,
            trigger: "test",
          } as ToolContext),
      }),
      // What's kept, as the system reads it.
      "test.read": defineAction({
        input: { type: "object", properties: { collection: { type: "string" } } },
        allow: () => true,
        run: (ctx, input) => ctx.as().db.collection(input.collection!).find({}),
      }),
    },
  });

type Setup = {
  rt: Awaited<ReturnType<typeof createRuntime>>;
  topic: string;
  host: ReturnType<typeof fakeHost>;
  directory: ReturnType<typeof fakeDirectory>;
};

async function setup(
  fn: (s: Setup) => Promise<void>,
  options: {
    failBuild?: string;
    taken?: string[];
    billing?: boolean;
    computers?: Record<string, unknown>;
  } = {},
) {
  const topic = `apps-test.${crypto.randomUUID()}`;
  const host = fakeHost(options);
  const directory = fakeDirectory(options.taken);
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      computers,
      ...(options.billing === false ? [] : [usage]),
      apps,
      testPlugin(host.host, directory, options.computers),
    ],
    transports: [{ type: "in-process", config: { topic } }],
  });
  try {
    await fn({ rt, topic, host, directory });
  } finally {
    await rt.close();
  }
}

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 500 && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

/** Ana's computer, connected (to her Personal space), sending `files` as its folder. */
async function connect(
  { rt, topic }: Setup,
  options: Omit<Parameters<typeof archivingComputer>[2], "archive"> & {
    files?: Record<string, string>;
  } = {},
) {
  const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
  const computer = archivingComputer(topic, `code:${code}`, {
    ...options,
    archive: await tgz(options.files ?? { "package.json": "{}", "server.js": "serve()" }),
  });
  await computer.worker.ready;
  const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
  await until(async () => (await mine())[0]?.online === true, "it came");
  return { ...computer, id: (await mine())[0]._id };
}

const appOf = async (rt: Setup["rt"], id: string) =>
  (await rt.call<AppDoc[]>("test.read", { collection: "app" })).find((a) => a._id === id)!;

const settled = (rt: Setup["rt"], id: string) =>
  until(async () => (await appOf(rt, id))?.status !== "building", "it was built");

test("a person publishes a job: building at once, then live, routed to its target and metered", async () => {
  await setup(async (s) => {
    const { rt, host, directory } = s;
    const computer = await connect(s, { jobs: [{ id: "j1", port: 3000, command: "npm start" }] });
    try {
      const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
      // The space's computer, said (its desk there): a desk not there isn't one.
      const [desk] = await rt.query<{ _id: string }[]>("desk.here", { in: space }, { actor: ana });
      const elsewhere = await rt.call("app.publish", {
        in: space,
        desk: "nope",
        name: "x",
        port: 1,
      }, {
        actor: ana,
      }).then(() => "made", (error) => (error as { code?: string }).code);
      assertEquals(elsewhere, "not_found");
      const published = await rt.call<Published>("app.publish", {
        in: space,
        desk: desk._id,
        job: "j1",
        name: "My Shop!",
      }, { actor: ana });
      assertEquals([published.status, published.url], ["building", "https://my-shop.copilotz.app"]);
      // Its host was claimed first, with nowhere to go yet.
      assertEquals(directory.said[0], ["my-shop.copilotz.app", undefined]);

      await settled(rt, published.app);
      const [app] = await rt.call<AppDoc[]>("app.list", { in: space }, { actor: ana });
      assertEquals(
        [app._id, app.status, app.label, app.service, app.target, app.revision, app.by],
        [
          published.app,
          "live",
          "my-shop",
          "svc/my-shop",
          "https://my-shop-abc.a.run.app",
          "my-shop-00001",
          "ana",
        ],
      );
      assertEquals(app.source, {
        computer: computer.id,
        port: 3000,
        command: "npm start",
        job: "j1",
      });
      assertEquals(app.revisions?.map((r) => r.revision), ["my-shop-00001"]);
      // Built from the folder the computer sent: the space's, never what an agent says.
      const archived = computer.asked.find((a) => a.work === WORK.archive)!;
      assertEquals(archived.input.scope, { space, folder: "personal", who: "person:ana" });
      assertEquals(host.calls.slice(0, 2), [
        {
          op: "build",
          app: "my-shop",
          command: "npm start",
          port: 3000,
          files: ["package.json", "server.js"],
        },
        { op: "deploy", app: "my-shop", image: "fake/my-shop:1", port: 3000 },
      ]);
      // The front now sends its host to its target.
      assertEquals(directory.claims.get("my-shop.copilotz.app"), "https://my-shop-abc.a.run.app");
      // Its build's minutes, in the ledger.
      const uses = await rt.call<
        { meter: string; subject: string; quantities: object; tags: object }[]
      >("test.read", { collection: "usage" });
      const build = uses.find((u) => u.meter === "app")!;
      assertEquals([build.subject, build.quantities, build.tags], [
        "app/build",
        { minutes: 2 },
        { app: published.app, space, person: "ana" },
      ]);
      // Nobody else sees it.
      assertEquals(await rt.call("app.list", {}, { actor: bob }), []);
      assertEquals(await rt.query("app.here", { in: space }, { actor: bob }), []);
    } finally {
      await computer.worker.stop();
    }
  });
});

test("an app runs with its space's environment, its own over it; configured, it's deployed again, no build", async () => {
  await setup(async (s) => {
    const { rt, host } = s;
    const computer = await connect(s, { jobs: [{ id: "j1", port: 3000, command: "npm start" }] });
    try {
      const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
      await rt.call("env.set", { in: space, name: "API_URL", value: "https://api.test" }, {
        actor: ana,
      });
      // A secret its computers don't get: its apps do.
      await rt.call("env.set", {
        in: space,
        name: "API_KEY",
        value: "sk-live-0123456789abcdef",
        secret: true,
        computers: false,
      }, { actor: ana });
      const published = await rt.call<Published>("app.publish", {
        in: space,
        job: "j1",
        name: "Shop",
      }, { actor: ana });
      await settled(rt, published.app);
      const deploys = () => host.calls.filter((c) => c.op === "deploy");
      assertEquals(deploys()[0].env, {
        API_URL: "https://api.test",
        API_KEY: "sk-live-0123456789abcdef",
      });

      // Its own, over its space's: saved, then its image deployed again, with no build.
      const builds = host.calls.filter((c) => c.op === "build").length;
      const configured = await rt.call<{ status: string; revision: string }>("app.configure", {
        app: published.app,
        env: [
          { name: "API_URL", value: "https://other.test" },
          { name: "TOKEN", value: "t-0123456789abcdefgh", secret: true },
        ],
      }, { actor: ana });
      assertEquals(configured, { status: "live", revision: "shop-00002" });
      assertEquals(deploys().at(-1), {
        op: "deploy",
        app: "shop",
        image: "fake/shop:1",
        port: 3000,
        env: {
          API_URL: "https://other.test",
          API_KEY: "sk-live-0123456789abcdef",
          TOKEN: "t-0123456789abcdefgh",
        },
      });
      assertEquals(host.calls.filter((c) => c.op === "build").length, builds, "no build");
      const app = await appOf(rt, published.app);
      assertEquals([app.revision, app.revisions?.length], ["shop-00002", 2]);
      // Its own, as people read them: the secret's value isn't there.
      const own = await rt.query<Record<string, unknown>[]>("envVar.here", {
        in: space,
        app: published.app,
      }, { actor: ana });
      assertEquals(own.map((v) => [v.name, v.value, v.secret, v.hint, "sealed" in v]), [
        ["API_URL", "https://other.test", false, undefined, false],
        ["TOKEN", undefined, true, "••••efgh", false],
      ]);
      // A change taken away: the space's again. Nobody else may.
      await rt.call("app.configure", {
        app: published.app,
        env: [{ name: "API_URL", remove: true }],
      }, {
        actor: ana,
      });
      assertEquals((deploys().at(-1)!.env as Record<string, string>).API_URL, "https://api.test");
      const refused = await rt.call("app.configure", { app: published.app }, { actor: bob }).then(
        () => "done",
        (error) => (error as { code?: string }).code,
      );
      assertEquals(refused, "not_found");
      // Every app's own in the space, as its Apps tab reads them.
      const owns = await rt.query<{ app: string; name: string }[]>("envVar.apps", { in: space }, {
        actor: ana,
      });
      assertEquals(owns.map((v) => [v.app, v.name]), [[published.app, "TOKEN"]]);
      // Taken down, its own go with it.
      await rt.call("app.remove", { app: published.app }, { actor: ana });
      assertEquals(await rt.query("envVar.apps", { in: space }, { actor: ana }), []);
      assertEquals(
        (await rt.query<unknown[]>("envVar.here", { in: space }, { actor: ana })).length,
        2,
      );
    } finally {
      await computer.worker.stop();
    }
  });
});

test("an agent's publish waits for its person's yes, even where nothing else is asked", async () => {
  await setup(async (s) => {
    const { rt } = s;
    const computer = await connect(s);
    try {
      const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
      const { thread } = await rt.call<{ thread: string }>("chat.send", {
        text: "hello",
        in: space,
      }, { actor: ana });
      await rt.idle();
      const tool = (name: string, input: Record<string, unknown>) =>
        rt.call<unknown>("test.tool", { tool: name, thread, input }, { actor: ana });

      // Commands, jobs and writes need no yes here (`approve: []`); publishing does.
      const waiting = String(await tool("publish", { name: "Blog", port: 8080 }));
      assertStringIncludes(waiting, "Waiting for ana's yes to publish this as an app");
      assertStringIncludes(waiting, "publish Blog on port 8080");
      assertEquals(await rt.call("app.list", { in: space }, { actor: ana }), []);
      const [asked] = await rt.query<Approval[]>("approval.pending", {}, { actor: ana });
      assertEquals([asked.work, asked.detail, asked.agent, asked.preview], [
        "publish",
        "publish Blog on port 8080",
        "assistant",
        // Where it'll be, as the card says it.
        "https://blog.copilotz.app",
      ]);

      // Yes, this once: it publishes, answering at once.
      await rt.call("computer.approve", { approval: asked._id, answer: "once" }, { actor: ana });
      await rt.idle();
      const published = await tool("publish", { name: "Blog", port: 8080 }) as Published & {
        note: string;
      };
      assertEquals([published.status, published.url], ["building", "https://blog.copilotz.app"]);
      assertStringIncludes(published.note, "live at https://blog.copilotz.app");
      await settled(rt, published.app);
      const app = await appOf(rt, published.app);
      assertEquals([app.status, app.by, app.source.port], ["live", "ana", 8080]);
      const archived = computer.asked.find((a) => a.work === WORK.archive)!;
      assertEquals(archived.input.scope, { space, folder: "personal", who: "person:ana" });

      // The yes was used up.
      assertStringIncludes(
        String(await tool("publish", { name: "Blog", port: 8080 })),
        "Waiting for ana's yes",
      );
    } finally {
      await computer.worker.stop();
    }
  }, { computers: { approve: [] } });
});

test("a build that fails leaves the app failed, saying why, and its minutes are metered", async () => {
  await setup(async (s) => {
    const { rt } = s;
    const computer = await connect(s);
    try {
      const published = await rt.call<Published>("app.publish", { name: "api", port: 4000 }, {
        actor: ana,
      });
      await settled(rt, published.app);
      const app = await appOf(rt, published.app);
      assertEquals([app.status, app.error, app.target], [
        "failed",
        "npm ERR! missing script: start",
        undefined,
      ]);
      const uses = await rt.call<{ meter: string; quantities: object }[]>("test.read", {
        collection: "usage",
      });
      assertEquals(uses.filter((u) => u.meter === "app").map((u) => u.quantities), [
        { minutes: 1 },
      ]);
    } finally {
      await computer.worker.stop();
    }
  }, { failBuild: "npm ERR! missing script: start" });
});

test("a folder the computer can't archive fails the app; without billing nothing is metered", async () => {
  await setup(async (s) => {
    const { rt, host } = s;
    const computer = await connect(s, {
      failArchive: { message: "it's over 512 MiB", code: "too_large" },
    });
    try {
      const published = await rt.call<Published>("app.publish", { name: "big", port: 4000 }, {
        actor: ana,
      });
      await settled(rt, published.app);
      const app = await appOf(rt, published.app);
      assertEquals(app.status, "failed");
      assertStringIncludes(app.error!, "couldn't archive the folder: it's over 512 MiB");
      assertEquals(host.calls, []);
      // No job, no port: it says what it needs.
      const refused = await rt.call("app.publish", { name: "x" }, { actor: ana }).then(
        () => "",
        (error) => (error as Error).message,
      );
      assertStringIncludes(refused, "Which port does it serve?");
    } finally {
      await computer.worker.stop();
    }
  }, { billing: false });
});

test("an archive that stops partway fails the app; a redeploy that fails leaves it live, saying why", async () => {
  await setup(async (s) => {
    const { rt } = s;
    const computer = await connect(s, { stopArchive: "it's over 512 MiB (too_large)" });
    try {
      const published = await rt.call<Published>("app.publish", { name: "big", port: 4000 }, {
        actor: ana,
      });
      await settled(rt, published.app);
      const app = await appOf(rt, published.app);
      assertEquals(app.status, "failed");
      // Relayed through the owner to plugin code, the stream's own message is lost (`handler_failed`).
      assertStringIncludes(app.error!, "couldn't archive the folder");
    } finally {
      await computer.worker.stop();
    }
  });

  await setup(async (s) => {
    const { rt, host } = s;
    const computer = await connect(s);
    try {
      const published = await rt.call<Published>("app.publish", { name: "site", port: 4000 }, {
        actor: ana,
      });
      await settled(rt, published.app);
      host.state.fail = "the new one doesn't build";
      await rt.call("app.redeploy", { app: published.app }, { actor: ana });
      await settled(rt, published.app);
      const app = await appOf(rt, published.app);
      // Its first revision still runs.
      assertEquals([app.status, app.error, app.revision], [
        "live",
        "the new one doesn't build",
        "site-00001",
      ]);
    } finally {
      await computer.worker.stop();
    }
  });
});

test("taking an app down removes it at the host and lets its host go: its publisher's or a manager's call", async () => {
  await setup(async (s) => {
    const { rt, host, directory } = s;
    const computer = await connect(s);
    try {
      // Ana's computer, shared into Team, where Bob and Cy are editors.
      const { space: team } = await rt.call<{ space: string }>("space.create", {
        name: "Team",
      }, { actor: ana });
      await join(rt, team, bob, "editor", ana);
      await join(rt, team, cy, "editor", ana);
      await rt.call("computer.share", { computer: computer.id, in: team }, { actor: ana });
      const published = await rt.call<Published>("app.publish", {
        in: team,
        name: "Team App",
        port: 5000,
      }, { actor: bob });
      await settled(rt, published.app);
      const archived = computer.asked.find((a) => a.work === WORK.archive)!;
      assertEquals(archived.input.scope, { space: team, folder: "team", who: "person:bob" });
      // The space's members see it.
      assertEquals(
        (await rt.call<AppDoc[]>("app.list", { in: team }, { actor: cy })).map((a) => a.label),
        ["team-app"],
      );

      // Cy neither published it nor manages Team.
      const refused = await rt.call("app.remove", { app: published.app }, { actor: cy }).then(
        () => "removed",
        (error) => (error as { code?: string }).code,
      );
      assertEquals(refused, "forbidden");
      // Ana manages Team.
      assertEquals(await rt.call("app.remove", { app: published.app }, { actor: ana }), {
        removed: true,
      });
      assertEquals(host.calls.filter((c) => c.op === "remove"), [{
        op: "remove",
        app: "team-app",
      }]);
      assertEquals(directory.released, ["team-app.copilotz.app"]);
      assertEquals(directory.claims.has("team-app.copilotz.app"), false);
      assertEquals((await appOf(rt, published.app)).status, "removed");
      assertEquals(await rt.call("app.list", { in: team }, { actor: bob }), []);
      // What it ran until then, metered as Bob's.
      const uses = await rt.call<{ subject: string; quantities: object; tags: object }[]>(
        "test.read",
        { collection: "usage" },
      );
      const ran = uses.find((u) => u.subject === "app/run")!;
      assertEquals([ran.quantities, ran.tags], [
        { vcpuSeconds: 10, gibSeconds: 5, requests: 7 },
        { app: published.app, space: team, person: "bob" },
      ]);
    } finally {
      await computer.worker.stop();
    }
  });
});

test("labels are DNS-safe and unique: here, and across orgs through the directory", async () => {
  assertEquals(slugOf("Café Shop!"), "cafe-shop");
  assertEquals(slugOf("42 things"), "app-42-things");
  assertEquals(slugOf("--"), "app");
  assertEquals(slugOf("x".repeat(80)).length, 40);
  assertEquals(slugOf(`${"a".repeat(39)} b`), "a".repeat(39));
  assert(kept("www") && kept("shop-preview") && !kept("shop"));
  assertMatch(suffixed("a".repeat(40)), /^a{35}-[a-z0-9]{4}$/);

  await setup(async (s) => {
    const { rt } = s;
    const computer = await connect(s);
    try {
      // Another org has shop.copilotz.app.
      const first = await rt.call<Published>("app.publish", { name: "Shop", port: 3000 }, {
        actor: ana,
      });
      assertMatch(first.url, /^https:\/\/shop-[a-z0-9]{4}\.copilotz\.app$/);
      const { space: team } = await rt.call<{ space: string }>("space.create", {
        name: "Team",
      }, { actor: ana });
      await rt.call("computer.share", { computer: computer.id, in: team }, { actor: ana });
      const second = await rt.call<Published>("app.publish", {
        in: team,
        name: "Shop",
        port: 3000,
      }, { actor: ana });
      assertMatch(second.url, /^https:\/\/shop-[a-z0-9]{4}\.copilotz\.app$/);
      assertNotEquals(second.url, first.url);
      // The same name in the same space is the same app: a new revision.
      await settled(rt, first.app);
      const again = await rt.call<Published>("app.publish", { name: "Shop", port: 3001 }, {
        actor: ana,
      });
      assertEquals([again.app, again.url, again.status], [first.app, first.url, "building"]);
      await settled(rt, first.app);
      const app = await appOf(rt, first.app);
      assertEquals([app.source.port, app.revisions?.length], [3001, 2]);
    } finally {
      await computer.worker.stop();
    }
  }, { taken: ["shop.copilotz.app"] });
});

test("redeploy builds a new revision; app.meter records what live apps ran", async () => {
  await setup(async (s) => {
    const { rt, host } = s;
    const computer = await connect(s);
    try {
      const published = await rt.call<Published>("app.publish", { name: "docs", port: 3000 }, {
        actor: ana,
      });
      // `docs` is kept for the front: it gets a suffix.
      assertMatch(published.url, /^https:\/\/docs-[a-z0-9]{4}\.copilotz\.app$/);
      await settled(rt, published.app);
      const redeployed = await rt.call<Published>("app.redeploy", { app: published.app }, {
        actor: ana,
      });
      assertEquals(redeployed.status, "building");
      await settled(rt, published.app);
      const app = await appOf(rt, published.app);
      assertEquals(app.status, "live");
      assertEquals(app.revisions?.map((r) => r.revision.slice(-5)), ["00001", "00002"]);
      assertEquals(host.calls.filter((c) => c.op === "build").length, 2);
      // Bob can't redeploy what he doesn't reach.
      const refused = await rt.call("app.redeploy", { app: published.app }, { actor: bob }).then(
        () => "ran",
        (error) => (error as { code?: string }).code,
      );
      assertEquals(refused, "not_found");

      const { metered } = await rt.call<{ metered: number }>("app.meter", {});
      assertEquals(metered, 1);
      const used = host.calls.find((c) => c.op === "usage")!;
      assertEquals(used.app, app.label);
      const uses = await rt.call<{ subject: string; quantities: object; tags: object }[]>(
        "test.read",
        { collection: "usage" },
      );
      const ran = uses.find((u) => u.subject === "app/run")!;
      assertEquals(ran.quantities, { vcpuSeconds: 10, gibSeconds: 5, requests: 7 });
      assert((await appOf(rt, published.app)).metered, "metered up to now");
    } finally {
      await computer.worker.stop();
    }
  });
});
