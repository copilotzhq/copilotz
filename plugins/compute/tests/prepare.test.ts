/**
 * A computer readied for a person's plans (`computer.prepare`), checked each
 * time, never from what its record remembers: an asleep cloud computer
 * wakes; its program older than the app's release, it's put to sleep and
 * woken again on a VM that runs the release; a laptop updates itself, and is
 * waited for; one that's off, or shared with others' agents, says so; then
 * what its plans' CLIs are now. The founder's test (an asleep cloud computer
 * on an old program, its CLI missing) ends with the CLI installed and signed
 * in. And a plan's call wakes an asleep cloud computer before it tries a
 * laptop that's off.
 */
import { assert, assertEquals } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type Message } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { type Computer, computers } from "../mod.ts";
import type { Prepared } from "../computers/actions/prepare.ts";
import { UPDATE } from "../computers/program/release.ts";
import {
  type EngineStatus,
  type LoginInput,
  type LoginState,
  type PromptEvent,
  WORK,
} from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";
import { until } from "./program-setup.ts";

const ana: Actor = { kind: "person", id: "ana" };
const RELEASE = "1.0.0-rc.66";
const OLD = "1.0.0-rc.60";
const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));
const read = async <T>(input: ReadableStream<Uint8Array>) =>
  JSON.parse(await new Response(input).text()) as T;

type Cli = { installed: boolean; signedIn: boolean; account?: string };

/** A computer of ana's, as a program stands in for it: a cloud one wakes, a laptop is turned on. */
type Machine = {
  id: string;
  cloud: boolean;
  /** Its program's version on each connection, the last for the rest. */
  versions: string[];
  /** What its plans' CLIs say. */
  clis: Record<string, Cli>;
  /** It takes the app's release, updating itself (a laptop's built program). */
  updates?: boolean;
  credential: string;
  worker?: ReturnType<typeof fakeComputer>;
};

type Setup = {
  rt: Awaited<ReturnType<typeof createRuntime>>;
  /** A computer of ana's, connected once (enrolled). */
  machine(
    given: Pick<Machine, "cloud" | "versions"> & Partial<Pick<Machine, "clis" | "updates">>,
    name: string,
  ): Promise<Machine>;
  connect(m: Machine): Promise<void>;
  disconnect(m: Machine): Promise<void>;
  record(id: string): Promise<Computer | undefined>;
  prepare(computer: string): Promise<Prepared>;
  woken: string[];
  slept: string[];
  logins: LoginInput[];
  prompts: string[];
};

async function setup(fn: (s: Setup) => Promise<void>) {
  const topic = `prepare-test.${crypto.randomUUID()}`;
  const machines = new Map<string, Machine>();
  const woken: string[] = [];
  const slept: string[] = [];
  const logins: LoginInput[] = [];
  const prompts: string[] = [];

  const plugin = definePlugin({
    name: "cloud-test",
    resources: {
      computerWake: { wake: "test.wake", sleep: "test.sleep", touch: "test.touch" },
      downloads: {
        base: "https://downloads.test/",
        manifest: {
          version: RELEASE,
          binaries: [{
            os: "testos",
            arch: "x64",
            file: "copilotz-computer-testos-x64",
            size: 1,
            sha256: "a".repeat(64),
          }],
        },
      },
      shared: { thread: {}, message: {} },
      agents: {
        north: {
          instructions: "Lead.",
          model: ["claude-plan/claude-haiku-5-5", "fake/echo"],
          default: true,
        },
      },
    },
    actions: {
      // As a cloud plugin wakes one: a new VM serves it, and it connects.
      "test.wake": defineAction({
        input: { type: "object", properties: { computer: { type: "string" } } },
        run: async (_ctx, input) => {
          const m = machines.get(input.computer!);
          if (!m?.cloud) return null;
          woken.push(m.id);
          await connect(m);
          return { state: "awake" };
        },
      }),
      "test.sleep": defineAction({
        input: { type: "object", properties: { computer: { type: "string" } } },
        run: async (_ctx, input) => {
          const m = machines.get(input.computer!);
          if (!m?.cloud) return null;
          slept.push(m.id);
          await disconnect(m);
          return { released: true };
        },
      }),
      "test.touch": defineAction({
        input: { type: "object", properties: { computer: { type: "string" } } },
        run: () => null,
      }),
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, plugin],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
  const record = async (id: string) => (await mine()).find((c) => c._id === id);

  const workloads = (m: Machine) => ({
    [WORK.agentsStatus]: () =>
      json(Object.entries(m.clis).map(([engine, cli]): EngineStatus => ({ engine, ...cli }))),
    [WORK.agentsLogin]: async ({ input }: { input: ReadableStream<Uint8Array> }) => {
      const asked = await read<LoginInput>(input);
      logins.push(asked);
      const cli = m.clis[asked.engine] ??= { installed: false, signedIn: false };
      // Missing, and not asked to install: it says so, as the program does.
      if (!cli.installed && !asked.install) {
        return json({ error: { message: `${asked.engine} isn't installed`, code: "missing" } });
      }
      if (asked.install) cli.installed = true;
      if (asked.input) {
        Object.assign(cli, { signedIn: true, account: "ana@example.com" });
        return json({ state: "done", output: "Signed in.\n", signedIn: true } satisfies LoginState);
      }
      return json(
        {
          state: "running",
          output: asked.install
            ? "Installing Claude Code…\nPaste the code:\n"
            : "Paste the code:\n",
          signedIn: false,
          url: "https://claude.ai/oauth/authorize?code=true",
        } satisfies LoginState,
      );
    },
    [WORK.agentsPrompt]: async ({ input }: { input: ReadableStream<Uint8Array> }) => {
      await read(input);
      prompts.push(m.id);
      const events: PromptEvent[] = [
        { i: 0, type: "session", session: "s-1" },
        {
          i: 1,
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `On ${m.id}.` },
          },
        },
        { i: 2, type: "done", stopReason: "end_turn" },
      ];
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          }
          controller.close();
        },
      });
    },
    // A laptop's built program: it updates, goes, and comes again as the release.
    ...(m.updates
      ? {
        [UPDATE]: async ({ input }: { input: ReadableStream<Uint8Array> }) => {
          const offer = await read<{ version: string }>(input);
          setTimeout(async () => {
            await disconnect(m);
            m.versions = [offer.version];
            await connect(m);
          }, 50);
          return json({ updating: true });
        },
      }
      : {}),
  });

  /** Connects `m`, as its next version; known once it's online (a new one: its id then). */
  async function connect(m: Machine) {
    const known = new Set((await mine()).map((c) => c._id));
    const version = m.versions.length > 1 ? m.versions.shift()! : m.versions[0];
    m.worker = fakeComputer(topic, m.credential, { info: { version }, workloads: workloads(m) });
    await m.worker.worker.ready;
    await until(async () => {
      const there = m.id ? await record(m.id) : (await mine()).find((c) => !known.has(c._id));
      if (there?.online) m.id ||= there._id;
      return !!there?.online && (there.info as { version?: string })?.version === version;
    }, `${m.id || "a new computer"} came`);
    // Enrolled: its id and secret from now on.
    await until(() => !m.worker!.credential().startsWith("code:"), "enrolled");
    m.credential = m.worker.credential();
    machines.set(m.id, m);
  }
  async function disconnect(m: Machine) {
    await m.worker?.worker.stop();
    m.worker = undefined;
    await until(async () => (await record(m.id))?.online === false, `${m.id} went`);
  }

  try {
    await rt.call("space.personal", {}, { actor: ana });
    await fn({
      rt,
      async machine(given, name) {
        const id = given.cloud
          ? (await rt.call<{ id: string }>("computer.provision", { owner: "ana", name })).id
          : "";
        const { code } = id
          ? await rt.call<{ code: string }>("computer.enrollment", { computer: id })
          : await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
        const m: Machine = {
          id,
          clis: {},
          ...given,
          versions: [...given.versions],
          credential: `code:${code}`,
        };
        await connect(m);
        if (!given.cloud) {
          await rt.call("computer.rename", { computer: m.id, name }, { actor: ana });
        }
        if (given.cloud) {
          await rt.call("computer.mark", {
            computer: m.id,
            status: { kind: "cloud", state: "awake" },
          });
        }
        return m;
      },
      connect,
      disconnect,
      record,
      prepare: (computer) => rt.call<Prepared>("computer.prepare", { computer }, { actor: ana }),
      woken,
      slept,
      logins,
      prompts,
    });
  } finally {
    for (const m of machines.values()) await m.worker?.worker.stop().catch(() => {});
    await rt.close();
  }
}

/** What a call failed with: its code, and what it said. */
const refusal = (error: unknown) => [(error as { code?: string }).code, (error as Error).message];

test("the founder's test: an asleep cloud computer on an old program, its CLI missing, ends installed and signed in", async () => {
  await setup(async (s) => {
    // Her cloud computer, asleep; its next VM runs an old program, the one after the release.
    const cloud = await s.machine({ cloud: true, versions: [OLD, OLD, RELEASE] }, "Cloud computer");
    await s.disconnect(cloud);
    cloud.clis = { claude: { installed: false, signedIn: false } };

    const ready = await s.prepare(cloud.id);
    // Woken, found old, put to sleep and woken again on the release; then asked what's there now.
    assertEquals(s.woken, [cloud.id, cloud.id]);
    assertEquals(s.slept, [cloud.id]);
    assertEquals(ready.program, { version: RELEASE, current: true });
    assertEquals(ready.online, true);
    assertEquals([ready.engines.claude?.installed, ready.engines.claude?.signedIn], [false, false]);

    // The flow's sign-in, installing first: a link, a code, done, and the CLI there.
    const login = (more: Record<string, unknown> = {}) =>
      s.rt.call<LoginState>(
        "computer.engine.login",
        { computer: cloud.id, engine: "claude", ...more },
        { actor: ana },
      );
    const first = await login({ install: true });
    assertEquals([first.state, first.url], [
      "running",
      "https://claude.ai/oauth/authorize?code=true",
    ]);
    const done = await login({ input: "c0de" });
    assertEquals([done.state, done.signedIn, done.installed], ["done", true, true]);
    assertEquals(s.logins.map((l) => [l.engine, l.install ?? null, l.input ?? null]), [
      ["claude", "curl -fsSL https://claude.ai/install.sh | bash", null],
      ["claude", null, "c0de"],
    ]);
    const kept = (await s.record(cloud.id))!.engines as Record<string, Cli>;
    assertEquals([kept.claude.signedIn, kept.claude.account], [true, "ana@example.com"]);
  });
});

test("a computer on the release is only asked; a laptop that's behind updates itself and is waited for", async () => {
  await setup(async (s) => {
    const desk = await s.machine({
      cloud: false,
      versions: [RELEASE],
      clis: { claude: { installed: true, signedIn: true, account: "ana@example.com" } },
    }, "Desk");
    const ready = await s.prepare(desk.id);
    assertEquals(ready.program, { version: RELEASE, current: true });
    assertEquals(ready.engines.claude?.account, "ana@example.com");
    assertEquals([s.woken, s.slept], [[], []]);

    const laptop = await s.machine({ cloud: false, versions: [OLD], updates: true }, "MacBook");
    const updated = await s.prepare(laptop.id);
    assertEquals(updated.program, { version: RELEASE, current: true });
    assertEquals(((await s.record(laptop.id))!.info as { version: string }).version, RELEASE);
  });
});

test("a laptop that can't update itself goes on as it is, saying so", async () => {
  await setup(async (s) => {
    const laptop = await s.machine({ cloud: false, versions: [OLD] }, "MacBook");
    const ready = await s.prepare(laptop.id);
    assertEquals(ready.program, { version: OLD, current: false });
    assertEquals(ready.online, true);
  });
});

test("a laptop that's off says so; a computer shared with others' agents can't run plans; and only one's own", async () => {
  await setup(async (s) => {
    const laptop = await s.machine({ cloud: false, versions: [RELEASE] }, "MacBook");
    await s.disconnect(laptop);
    assertEquals(await s.prepare(laptop.id).catch(refusal), ["offline", "MacBook is off."]);
    assertEquals(s.woken, []);

    await s.connect(laptop);
    const { space } = await s.rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    });
    await s.rt.call("computer.share", { computer: laptop.id, in: space }, { actor: ana });
    assertEquals(await s.prepare(laptop.id).catch(refusal), [
      "computer_shared",
      "MacBook is shared with others' agents, so your plans can't run on it.",
    ]);

    const cy: Actor = { kind: "person", id: "cy" };
    const theirs = await s.rt.call("computer.prepare", { computer: laptop.id }, { actor: cy })
      .catch(refusal);
    assertEquals((theirs as string[])[0], "forbidden");
  });
});

test("a plan's call wakes the asleep cloud computer before it tries a laptop that's off", async () => {
  await setup(async (s) => {
    const signed = { claude: { installed: true, signedIn: true, account: "ana@example.com" } };
    const cloud = await s.machine({ cloud: true, versions: [RELEASE], clis: signed }, "Cloud");
    const laptop = await s.machine({ cloud: false, versions: [RELEASE], clis: signed }, "MacBook");
    await s.prepare(cloud.id);
    await s.prepare(laptop.id);
    // The cloud one sleeps, then the laptop goes off: seen last, it was tried first.
    await s.disconnect(cloud);
    await s.rt.call("computer.mark", {
      computer: cloud.id,
      status: { kind: "cloud", state: "asleep" },
    });
    await s.disconnect(laptop);
    assert(
      ((await s.record(laptop.id))!.seen ?? "") > ((await s.record(cloud.id))!.seen ?? ""),
      "the laptop was seen last",
    );

    const { space } = await s.rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { thread } = await s.rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await s.rt.idle();
    const said = await s.rt.query<Message[]>("message.history", { thread }, { actor: ana });
    assertEquals(said.at(-1)?.text, `On ${cloud.id}.`);
    assertEquals(s.prompts, [cloud.id]);
    assertEquals(s.woken, [cloud.id]);
  });
});
