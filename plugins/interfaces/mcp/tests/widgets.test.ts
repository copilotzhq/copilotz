/**
 * A line's widgets (see resources/widgets.ts): the app's web Views drawn inside the assistant,
 * through the app's widgets (`widgetsOf`, a resource). The template is a resource; a tool shown
 * through a widget answers what the widget draws in `_meta` (its View, the call, a snapshot of
 * what the View reads as the conversation's contact, the widget's grant), never in what the
 * model reads; what only the widgets call (an Action, the read tool) is refused without the
 * grant, with a forged one and with another conversation's, and made as the contact with it.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  defineAction,
  definePlugin,
  failure,
  peopleOrContacts,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { tool } from "../../../agents/chat/mod.ts";
import { widgetsOf } from "../../../../hosts/web/widgets.ts";
import { test } from "../../../../testing/mod.ts";
import { LINE, said, setup } from "./setup.ts";

const ORIGIN = "https://app.example";

/** How many times `card.write` ran. */
let writes = 0;

/** Cards, one per chat: written by a tool (the model's) or an Action (the widget's, by hand). */
const cards = definePlugin({
  name: "cards",
  collections: {
    card: {
      schema: {
        type: "object",
        properties: {
          chat: { type: "string" },
          text: { type: "string" },
          secret: { type: "string" },
        },
        required: ["chat", "text"],
      },
      private: ["secret"],
      queries: {
        // A chat's card, for whoever reaches the chat (as Mobizap's booking.panel is).
        mine: {
          allow: peopleOrContacts,
          run: async (cards, params: { chat: string }, ctx) => {
            const thread = await ctx.db.collection("thread").findOne({ _id: params.chat });
            return thread ? await cards.findOne({ chat: params.chat }) : null;
          },
        },
      },
    },
  },
  actions: {
    "card.write": defineAction({
      description: "Writes the chat's card, by hand",
      input: {
        type: "object",
        properties: { chat: { type: "string" }, text: { type: "string" } },
        required: ["chat", "text"],
        additionalProperties: false,
      },
      allow: peopleOrContacts,
      run: async (ctx, input) => {
        if (!await ctx.db.collection("thread").findOne({ _id: input.chat })) {
          throw failure("forbidden", "That isn't your chat.", { public: true });
        }
        if (input.text === "no") throw failure("refused", "Not that card.", { public: true });
        await ctx.db.collection("card").replaceOne(
          { _id: input.chat },
          { chat: input.chat, text: input.text, secret: "s3cret" },
          { upsert: true },
        );
        return { written: input.text, code: "for the widget only", n: ++writes };
      },
    }),
  },
  views: { "tool:show_card": () => "A card is shown." },
  resources: {
    tools: {
      show_card: tool({
        description: "Shows the chat's card",
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        run: async (input, ctx) => {
          await ctx.db.collection("card").replaceOne(
            { _id: ctx.thread },
            { chat: ctx.thread, text: input.text, secret: "s3cret" },
            { upsert: true },
          );
          return { shown: input.text };
        },
      }),
    },
  },
});

/** The widget's front end: the card, as its View reads it (here, as text). */
const cardsWeb = definePlugin({
  name: "cards-web",
  views: {
    "card.widget": (item: { name: string }, ctx: ViewContext) => {
      const card = ctx.db.collection("card").query<{ text: string } | null>("mine", {
        chat: ctx.hints.thread,
      }).value;
      return `${item.name}: ${card?.text ?? "…"} (${ctx.hints.mode})`;
    },
  },
});

const widgets = () =>
  widgetsOf({
    code: { entry: "widget.js", files: { "widget.js": 'console.log("</script> stays in");' } },
    plugins: [cardsWeb],
    lang: "pt-BR",
  });

const line = {
  tools: {
    ...LINE.tools,
    show_card: { widget: "card.widget", invoking: "Showing…" },
    write_card: { action: "card.write", title: "Write the card" },
  },
  widgets: { domain: "https://widgets.app.example", prefersBorder: true, description: "A card." },
};

// deno-lint-ignore no-explicit-any
type Tool = { name: string; _meta?: Record<string, any>; inputSchema: { properties?: object } };
// deno-lint-ignore no-explicit-any
const res = (rpc: { body: unknown }) => (rpc.body as any).result;
// deno-lint-ignore no-explicit-any
const err = (rpc: { body: unknown }) => (rpc.body as any).error;

test("tools say who calls them and which template draws them; resources are the template", async () => {
  await setup(async (s) => {
    const tools = res(await s.legacy("tools/list")).tools as Tool[];
    const by = (name: string) => tools.find((t) => t.name === name)!;
    const uri = by("show_card")._meta!.ui.resourceUri as string;
    assertMatch(uri, /^ui:\/\/chatgpt\/widget-[0-9a-f]{12}\.html$/);
    assertEquals(by("show_card")._meta!["openai/outputTemplate"], uri);
    assertEquals(by("show_card")._meta!.ui.visibility, ["model", "app"]);
    assertEquals(by("write_card")._meta!.ui, { visibility: ["app"] });
    assertEquals(by("write_card")._meta!["openai/visibility"], "private");
    assert("_grant" in by("write_card").inputSchema.properties!);
    assertEquals(by("copilotz_read")._meta!.ui, { visibility: ["app"] });
    assertEquals(by("search")._meta!.ui, { visibility: ["model", "app"] });

    const init = await s.legacy("initialize", { protocolVersion: "2025-11-25" });
    assertEquals(res(init).capabilities, { tools: {}, resources: {} });
    const list = await s.legacy("resources/list");
    const [template] = res(list).resources;
    assertEquals([template.uri, template.mimeType], [uri, "text/html;profile=mcp-app"]);
    const read = await s.legacy("resources/read", { uri });
    const [page] = res(read).contents;
    assertEquals(page.mimeType, "text/html;profile=mcp-app");
    assertStringIncludes(page.text, '<html lang="pt-BR">');
    assertStringIncludes(page.text, 'console.log("<\\/script> stays in");');
    assertEquals(page._meta.ui, {
      csp: { connectDomains: [], resourceDomains: [ORIGIN] },
      domain: "https://widgets.app.example",
      prefersBorder: true,
    });
    assertEquals(page._meta["openai/widgetCSP"], {
      connect_domains: [],
      resource_domains: [ORIGIN],
    });
    assertEquals(page._meta["openai/widgetDescription"], "A card.");
    // An older template's URI is answered with today's page; anything else isn't a resource.
    const old = await s.legacy("resources/read", { uri: "ui://chatgpt/widget-000000000000.html" });
    assertEquals(res(old).contents[0].text, page.text);
    const other = await s.legacy("resources/read", { uri: "ui://other/widget-1.html" });
    assertEquals(err(other).code, -32602);
  }, { line, plugins: [cards], widgets: widgets() });
});

test("without the app's widgets: no template, and nothing only widgets call is listed", async () => {
  await setup(async (s) => {
    const tools = res(await s.legacy("tools/list")).tools as Tool[];
    const names = tools.map((t) => t.name);
    assert(names.includes("show_card"));
    assert(!names.includes("write_card") && !names.includes("copilotz_read"));
    assertEquals(tools.find((t) => t.name === "show_card")!._meta!.ui, undefined);
    assertEquals(err(await s.legacy("resources/list")).code, -32601);
    const refused = await s.call("write_card", { chat: "x", text: "a" }, { session: "s1" });
    assertEquals(err(refused).code, -32602);
  }, { line, plugins: [cards] });
});

test("a tool drawn by a widget answers what it draws in _meta, its reads already answered", async () => {
  await setup(async (s) => {
    const shown = await s.call("show_card", { text: "Hello" }, { session: "s1" });
    const result = res(shown);
    assertEquals(said(shown), "A card is shown.");
    const widget = result._meta["copilotz/widget"];
    assertEquals(widget.view, "card.widget");
    assertEquals([widget.item.name, JSON.parse(widget.item.output)], ["show_card", {
      shown: "Hello",
    }]);
    assertMatch(widget.hints.thread, /^mcp-/);
    assertEquals(widget.viewer.kind, "contact");
    assertMatch(widget.grant, /^g2\.c-[0-9a-f]{24}\.[0-9a-z]+\.[0-9a-f]{32}$/);
    assertEquals(widget.tools, { "card.write": "write_card" });
    assertEquals(widget.read, "copilotz_read");
    // What the View read, answered as the contact, without private fields.
    const [[key, answer]] = widget.reads;
    assertStringIncludes(key, "mine");
    assertEquals(answer.value.text, "Hello");
    assertEquals(answer.value.secret, undefined);
    // The model reads only content: no grant, no reads in it.
    assert(!JSON.stringify(result.content).includes(widget.grant));
  }, { line, plugins: [cards], widgets: widgets() });
});

test("what only widgets call is refused to the model: no grant, a forged one, another conversation's", async () => {
  await setup(async (s) => {
    const first = await s.call("show_card", { text: "Hello" }, { session: "s1" });
    const { grant, hints } = res(first)._meta["copilotz/widget"];
    const other = await s.call("show_card", { text: "Theirs" }, { session: "s2" });
    const theirs = res(other)._meta["copilotz/widget"];
    const write = (input: Record<string, unknown>, session = "s1") =>
      s.call("write_card", { chat: hints.thread, text: "By hand", ...input }, { session });

    for (
      const attempt of [{}, { _grant: "g2.c-000000000000000000000000.zz.0000" }, {
        _grant: grant.replace(/.$/, (c: string) => c === "0" ? "1" : "0"),
      }, { _grant: theirs.grant }]
    ) {
      const refused = await write(attempt);
      assertEquals(res(refused).isError, true);
      assertStringIncludes(said(refused), "only the widget calls it");
    }
    // Another conversation's widget, naming this chat with its own grant: the rules say no.
    const stranger = await write({ _grant: theirs.grant }, "s2");
    assertEquals(res(stranger).isError, true);
    assertEquals(res(stranger)._meta["copilotz/error"].code, "forbidden");
    // Its own widget: the Action runs as the contact; its result is for the widget alone.
    const done = await write({
      _grant: grant,
      _reads: [{
        key: "k",
        read: {
          collection: "card",
          query: "mine",
          params: { chat: hints.thread },
        },
      }],
    });
    assertEquals(said(done), "Done in the widget.");
    assertEquals(res(done)._meta["copilotz/result"].written, "By hand");
    assertEquals(res(done)._meta["copilotz/reads"], [["k", {
      value: { _id: hints.thread, chat: hints.thread, text: "By hand" },
    }]]);
    assert(!JSON.stringify(res(done).content).includes("for the widget only"));
    // A refusal's words go to the widget alone; what a model may read says only it didn't go.
    const no = await write({ _grant: grant, text: "no" });
    assertEquals(said(no), "It didn't go through in the widget.");
    assertEquals(res(no)._meta["copilotz/error"], { message: "Not that card.", code: "refused" });
    // Each reply brings a new grant, good as the first.
    assertMatch(res(done)._meta["copilotz/grant"], /^g2\./);
  }, { line, plugins: [cards], widgets: widgets() });
});

test("the widgets' read tool: queries as the contact, with the grant; nothing read directly", async () => {
  await setup(async (s) => {
    const first = await s.call("show_card", { text: "Hello" }, { session: "s1" });
    const { grant, hints } = res(first)._meta["copilotz/widget"];
    const reads = [
      { key: "a", read: { collection: "card", query: "mine", params: { chat: hints.thread } } },
      { key: "b", read: { op: { op: "find", collection: "card", filter: {} } } },
    ];
    const none = await s.call("copilotz_read", { reads }, { session: "s1" });
    assertEquals(res(none).isError, true);
    const read = await s.call("copilotz_read", { reads, _grant: grant }, { session: "s1" });
    const answers = new Map(res(read)._meta["copilotz/reads"]);
    assertEquals((answers.get("a") as { value: { text: string } }).value.text, "Hello");
    assertEquals((answers.get("b") as { error: { code: string } }).error.code, "forbidden");
  }, { line, plugins: [cards], widgets: widgets() });
});

test("a line's widgets are checked at start: an Action that isn't, one the model calls, a domain", async () => {
  const bad = async (entry: Record<string, unknown>, widgets?: Record<string, unknown>) => {
    try {
      await setup(async () => {}, {
        line: { tools: { ...LINE.tools, x: entry }, ...(widgets ? { widgets } : {}) },
        plugins: [cards],
      });
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  assertStringIncludes(await bad({ action: "card.nope" }), "isn't one of the app's Actions");
  assertStringIncludes(
    await bad({ action: "card.write", visibility: ["model", "app"] }),
    "only the widgets call it",
  );
  assertStringIncludes(
    await bad({ action: "card.write" }, { domain: "http://x.example" }),
    "https origin",
  );
});

test("a template that can't be made: the line goes on without widgets, its tools still answer", async () => {
  const failing = widgetsOf({
    code: () => Promise.reject(new Error("the bundle failed")),
    plugins: [cardsWeb],
  });
  await setup(async (s) => {
    const init = await s.legacy("initialize", { protocolVersion: "2025-11-25" });
    assertEquals(res(init).capabilities, { tools: {} });
    const names = (res(await s.legacy("tools/list")).tools as Tool[]).map((t) => t.name);
    assert(names.includes("show_card") && !names.includes("write_card"));
    const shown = await s.call("show_card", { text: "Hi" }, { session: "s1" });
    assertEquals([said(shown), res(shown)._meta], ["A card is shown.", undefined]);
  }, { line, plugins: [cards], widgets: failing });
});

test("a grant is the conversation's alone: named with it on a line without handles, and only for hours", async () => {
  await setup(async (s) => {
    const first = await s.call("show_card", { text: "Hello" }, { session: "s1" });
    const { grant, hints } = res(first)._meta["copilotz/widget"];
    const write = (o: { session?: string } = {}, extra: Record<string, unknown> = {}) =>
      s.call("write_card", { chat: hints.thread, text: "By hand", _grant: grant, ...extra }, o);
    // A grant alone, naming no conversation: refused where ChatGPT names every one.
    const alone = await write();
    assertEquals(res(alone).isError, true);
    assertStringIncludes(said(alone), "only the widget calls it");
    assertEquals(said(await write({ session: "s1" })), "Done in the widget.");
    // Past its hours, it's no grant (a widget in use always holds a newer one).
    const later = Date.now;
    Date.now = () => later() + 7 * 3_600_000;
    try {
      const old = await write({ session: "s1" });
      assertStringIncludes(said(old), "only the widget calls it");
    } finally {
      Date.now = later;
    }
  }, { line: { ...line, handles: false }, plugins: [cards], widgets: widgets() });
});

test("a widget call runs once by its own id, whatever the request's; the template is read a few times a minute", async () => {
  await setup(async (s) => {
    const first = await s.call("show_card", { text: "Hello" }, { session: "s1" });
    const { grant, hints } = res(first)._meta["copilotz/widget"];
    const write = (text: string, call: string) =>
      s.call("write_card", { chat: hints.thread, text, _grant: grant, _call: call }, {
        session: "s1",
        id: 1,
      });
    // The same request id from a host that counts from 1 again: two taps are two calls.
    await write("one", "tap-aaaaaaaa");
    await write("two", "tap-bbbbbbbb");
    const after = res(
      await s.call("copilotz_read", {
        reads: [{
          key: "k",
          read: { collection: "card", query: "mine", params: { chat: hints.thread } },
        }],
        _grant: grant,
      }, { session: "s1" }),
    )._meta["copilotz/reads"];
    assertEquals(after[0][1].value.text, "two");
    // A retry of the same tap (its id, its input) is answered from the first: it ran once.
    const once = res(await write("two", "tap-bbbbbbbb"))._meta["copilotz/result"].n;
    const twice = res(await write("two", "tap-bbbbbbbb"))._meta["copilotz/result"].n;
    assertEquals(once, twice);
    assertEquals(res(await write("two", "tap-cccccccc"))._meta["copilotz/result"].n, twice + 1);
    // The template, past a few reads a minute from one address: busy.
    const uri = res(await s.legacy("resources/list")).resources[0].uri;
    let refused = 0;
    for (let i = 0; i < 35; i++) {
      if (err(await s.legacy("resources/read", { uri }))?.code === -31000) refused++;
    }
    assert(refused >= 5, `refused ${refused}`);
  }, { line, plugins: [cards], widgets: widgets() });
});

test("the template keeps the code inside its element: </SCRIPT> in any case, and <!--", async () => {
  const page = await widgetsOf({
    code: { entry: "w.js", files: { "w.js": 'a("</SCRIPT><img src=x>"); b("<!-- c");' } },
    plugins: [cardsWeb],
  }).page("https://app.example");
  assert(!/<\/script><img/i.test(page.html));
  assertStringIncludes(page.html, "<\\/SCRIPT>");
  assert(!page.html.includes('b("<!--'));
});
