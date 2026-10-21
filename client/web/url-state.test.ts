import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type BrowserPlugin,
  type BrowserViewContext,
  createBrowserRuntime,
  urlReference,
  urlStorageAdapter,
} from "./index.ts";
import {
  defineView,
  type ViewReference,
  type ViewUrl,
} from "../../runtime/views/index.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("urlReference admits identifiers and plain scalars only, marked as URL state", () => {
  assert.deepEqual(urlReference({ shows: "thread", value: { id: "t" } }), {
    shows: "thread",
    value: { id: "t" },
    origin: "url",
  });
  assert.deepEqual(
    urlReference({ shows: { list: "thread" } }),
    { shows: { list: "thread" }, value: null, origin: "url" },
  );
  assert.deepEqual(
    urlReference({
      shows: "board",
      value: { id: "b", page: 2, archived: false, card: null },
    })?.value,
    { id: "b", page: 2, archived: false, card: null },
  );
  for (
    const candidate of [
      // A full record payload is never decoded from a URL.
      { shows: "message", value: { content: [{ type: "text", text: "x" }] } },
      { shows: "adminQuery", value: { section: "a", query: { q: "x" } } },
      { shows: "thread", value: ["t"] },
      { shows: "thread", value: { id: Number.NaN } },
      { shows: "", value: null },
      { shows: { list: "a", action: "b" }, value: null },
      { value: { id: "t" } },
      null,
      "thread",
    ]
  ) assert.equal(urlReference(candidate), null, JSON.stringify(candidate));
});

test("URL Collection storage carries flat scalar rows and ignores anything else", async () => {
  let url = new URL("https://app.example/");
  const plugin: BrowserPlugin = {
    id: "nav",
    collections: {
      nav: {
        placement: "browser",
        storage: "url",
        initial: [{ id: "main", tab: "overview" }],
        commands: {
          set: { mutate: ({ input }) => ({ set: input as object }) },
        },
      },
    },
    actions: {
      setNav: {
        id: "nav.set",
        placement: "browser",
        execute: (input, ctx) => ctx.command("nav", "main", "set", input),
      },
    },
  };
  const boot = (href: string) => {
    url = new URL(href);
    return createBrowserRuntime({
      plugins: [plugin],
      storage: {
        url: urlStorageAdapter({
          read: () => url,
          replace: (next) => {
            url = next;
          },
        }),
      },
      onError: () => {},
    });
  };
  const param = (rows: unknown) => encodeURIComponent(JSON.stringify(rows));
  for (
    const href of [
      `https://app.example/?workspace.nav=${
        param([{ id: "main", record: { content: "spoof" } }])
      }`,
      "https://app.example/?workspace.nav=%7Bnot-json",
    ]
  ) {
    const runtime = await boot(href);
    assert.deepEqual(runtime.collections.nav.get("main").value, {
      id: "main",
      tab: "overview",
    });
    runtime.dispose();
  }
  const runtime = await boot(
    `https://app.example/?workspace.nav=${
      param([{ id: "main", tab: "members" }])
    }`,
  );
  try {
    assert.equal(runtime.collections.nav.get("main").value?.tab, "members");
    await runtime.actions.setNav({ page: 3 }).result();
    await runtime.flushStorage();
    assert.deepEqual(JSON.parse(url.searchParams.get("workspace.nav")!), [
      { id: "main", tab: "members", page: 3 },
    ]);
    await runtime.actions.setNav({ record: { id: "r" } }).result();
    await assert.rejects(runtime.flushStorage(), /flat scalar rows only/);
    assert.equal(
      JSON.parse(url.searchParams.get("workspace.nav")!)[0].record,
      undefined,
    );
  } finally {
    runtime.dispose();
  }
});

type Output = Readonly<{ label: string; load(): void }>;
/** Each View reads one query; `load` is what its rendered button would call. */
async function boot(calls: { id: string; input: unknown }[]) {
  const view = (shows: string, url?: ViewUrl) =>
    defineView<{ id: string }, Output, BrowserViewContext>({
      id: `app.${shows}`,
      shows,
      renderer: "default",
      modes: ["full"],
      ...(url ? { url } : {}),
      render(value, ctx) {
        const state = ctx.readAction("lookup", { id: value.id });
        return { label: `${value.id}:${state.status}`, load: state.refresh };
      },
    });
  const sneaky = defineView<null, string, BrowserViewContext>({
    id: "app.sneaky",
    shows: "sneaky",
    renderer: "default",
    modes: ["full"],
    url: true,
    render(_value, ctx) {
      ctx.readAction("lookup", { id: "sneaky" }).refresh();
      return "started";
    },
  });
  return await createBrowserRuntime({
    plugins: [{
      id: "app",
      views: {
        inline: view("inline"),
        held: view("held", true),
        run: view("run", { queries: "run" }),
        sneaky,
      },
      actions: {
        lookup: { id: "app.lookup", placement: "server", query: { reads: [] } },
      },
    }],
    actions: {
      invoke(id, input) {
        calls.push({ id, input });
        return Promise.resolve({ value: { ok: true }, seq: 1 });
      },
      cancel: () => Promise.resolve(),
    },
  });
}
const fromUrl = (shows: string, value: unknown) =>
  urlReference({ shows, value })!;

test("URL state renders only Views that declare url, with identifier values", async () => {
  const runtime = await boot([]);
  try {
    assert.throws(
      () => runtime.render(fromUrl("inline", { id: "a" })),
      /'app\.inline' cannot be opened from a URL/,
    );
    // The same View still renders from in-app navigation.
    assert.equal(
      (runtime.render({ shows: "inline", value: { id: "b" } }) as Output).label,
      "b:loading",
    );
    assert.equal(
      (runtime.render(fromUrl("held", { id: "a" })) as Output).label,
      "a:held",
    );
    // A marker on a hand-built record payload does not bypass the value rule.
    const forged = {
      shows: "held",
      value: { id: "a", content: [{ text: "spoof" }] },
      origin: "url",
    } as ViewReference;
    assert.throws(() => runtime.render(forged), /cannot be opened from a URL/);
  } finally {
    runtime.dispose();
  }
});

test("query reads from URL state wait for a user gesture unless the View declares they run", async () => {
  const calls: { id: string; input: unknown }[] = [];
  const runtime = await boot(calls);
  const output = runtime.observe(() =>
    runtime.render(fromUrl("held", { id: "from-url" })) as Output
  );
  try {
    await tick();
    assert.equal(output.getSnapshot().label, "from-url:held");
    assert.equal(calls.length, 0, "URL input must not submit the query Action");
    // A View cannot start its own held read while rendering.
    assert.throws(
      () => runtime.render(fromUrl("sneaky", null)),
      /cannot start a held query during render/,
    );
    assert.equal(calls.length, 0);
    // The user gesture: an event handler calls refresh() on the held state.
    output.getSnapshot().load();
    await tick();
    assert.deepEqual(calls, [{ id: "lookup", input: { id: "from-url" } }]);
    assert.equal(output.getSnapshot().label, "from-url:ready");
    // In-app navigation and a View declaring queries "run" start immediately.
    for (
      const reference of [
        { shows: "held", value: { id: "in-app" } },
        fromUrl("run", { id: "declared" }),
      ]
    ) {
      const run = runtime.observe(() => runtime.render(reference) as Output);
      await tick();
      assert.deepEqual(calls.at(-1)?.input, reference.value);
      assert.match(run.getSnapshot().label, /:ready$/);
      run.dispose();
    }
  } finally {
    output.dispose();
    runtime.dispose();
  }
});
