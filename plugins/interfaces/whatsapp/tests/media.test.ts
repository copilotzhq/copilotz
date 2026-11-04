/**
 * Media on WhatsApp, against a fake Graph API: an agent's picture goes as a
 * signed link the web host serves without a session (an expired or altered
 * one is a 404), with the text as its caption; without the app's `links`,
 * it's uploaded; a route's link carries its params, which the route checks;
 * a carousel's pictures must be links, so with none its fallback goes.
 */
import { assert, assertEquals } from "@std/assert";
import { defineAction, definePlugin, verifyLink } from "../../../../runtime/mod.ts";
import type { Message } from "../../../agents/chat/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { carousel, image, text } from "../contract.ts";
import { ana, type Setup, setup, threadsOf } from "./setup.ts";

const CARLA = "5511911112222";
const ORIGIN = "https://app.test";
const SECRET = "links-secret-for-tests-0123456789abcdef";
const PNG = btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3));

/** Where the app is, and the secret its links are signed with. */
const linked = definePlugin({
  name: "linked",
  resources: { links: { origin: ORIGIN, secret: SECRET } },
});

/** A route that draws a trip's card from its signed link, and a feature that shows one. */
const cards = definePlugin({
  name: "cards",
  resources: {
    routes: { "trip-card": { path: "/media/trip-card", action: "test.card", methods: ["GET"] } },
    additions: { card: { order: 1 }, trips: { order: 2 } },
  },
  actions: {
    "test.card": defineAction({
      input: { type: "object" },
      allow: () => true,
      record: false,
      run: async (ctx, request: { path: string; query: Record<string, string> }) => {
        const params = await verifyLink(
          { origin: ORIGIN, secret: SECRET },
          request.path,
          request.query,
        );
        return params
          ? { status: 200, headers: { "content-type": "text/plain" }, body: `card ${params.trip}` }
          : { status: 403, body: "Forbidden" };
      },
    }),
  },
  views: {
    "addition:card": {
      whatsapp: ({ answer }: { answer: Message }) =>
        answer.text?.includes("card")
          ? { key: "card:123", parts: [image({ route: "trip-card", params: { trip: "123" } })] }
          : undefined,
    },
    "addition:trips": {
      whatsapp: ({ answer }: { answer: Message }) =>
        answer.text?.includes("trips")
          ? {
            key: "trips:1",
            parts: [carousel(
              "Some trips",
              ["f1", "f2"].map((file, i) => ({
                image: { file },
                buttons: [{ id: `trip:${i}`, title: `Trip ${i}` }],
              })),
            )],
            fallback: [text("1. 10:30\n2. 12:00")],
          }
          : undefined,
    },
  },
});

const open = (s: Setup) =>
  s.runtime.call("whatsapp.set", { number: s.number, open: true, quiet: 0 }, { actor: ana });
const write = (s: Setup, body: string) =>
  s.deliver([{ text: { body } }], { from: CARLA, name: "Carla" });
/** The customer's chat, and an agent's message there with a file. */
async function sendFile(s: Setup, type: string, data = PNG) {
  await open(s);
  await write(s, "hi");
  const [chat] = await threadsOf(s.runtime, s.launch);
  const file = await s.runtime.call<string>("test.file", {
    thread: chat._id,
    text: "Here's your PIX code.",
    type,
    data,
  });
  await s.runtime.idle();
  return file;
}
/** A feature that shows a named file after an answer: for whom may read it only. */
const shows = definePlugin({
  name: "shows",
  resources: { additions: { picture: { order: 1 } } },
  actions: {
    // An agent's answer in a chat, as a turn writes one, that the picture follows.
    "test.show": defineAction({
      input: { type: "object" },
      run: async (ctx, input: { thread: string; file: string }) => {
        const [last] = await ctx.db.collection<Message>("message").find(
          { thread: input.thread, from: { $ne: "lead" } },
          { sort: { at: -1 }, limit: 1 },
        );
        const turn = crypto.randomUUID();
        await ctx.db.collection("message").insertOne({
          _id: `${turn}:reply`,
          thread: input.thread,
          ...(last.in ? { in: last.in } : {}),
          from: "lead",
          to: [last.from],
          text: "Here it is.",
          hops: 1,
          turn,
          picture: input.file,
          at: new Date().toISOString(),
        });
      },
    }),
  },
  views: {
    "addition:picture": {
      whatsapp: ({ answer }: { answer: Message & { picture?: string } }) =>
        answer.picture
          ? {
            key: `picture:${answer.picture}`,
            parts: [image({ file: answer.picture })],
            fallback: [text("(the picture isn't yours to see)")],
          }
          : undefined,
    },
  },
});

/** A link as the web host gets it, here. */
const local = (link: string) => new Request(link.replace(ORIGIN, "http://localhost"));

test("an agent's picture goes as a signed link, its text the caption, served without a session", async () => {
  await setup(async (s) => {
    const file = await sendFile(s, "image/png");
    const sent = s.graph.sent(CARLA).at(-1)!;
    const picture = sent.image as { link: string; caption: string };
    assertEquals([sent.type, picture.caption], ["image", "Here's your PIX code."]);
    assert(picture.link.startsWith(`${ORIGIN}/files/${encodeURIComponent(file)}?exp=`));
    // Meta fetches it: no session, just the link.
    const served = await s.serve(local(picture.link));
    assertEquals(served.status, 200);
    assertEquals(new Uint8Array(await served.arrayBuffer())[1], 80);
    // Altered, or without its signature: nothing.
    const altered = new URL(picture.link);
    altered.searchParams.set("exp", String(Number(altered.searchParams.get("exp")) + 60));
    assertEquals((await s.serve(local(altered.href))).status, 404);
    assertEquals((await s.serve(local(picture.link.split("?")[0]))).status, 404);
  }, { plugins: [linked] });
});

test("without the app's links, a file is uploaded to Meta and sent by its id", async () => {
  await setup(async (s) => {
    await sendFile(s, "application/pdf", btoa("%PDF-1.4 ticket"));
    const upload = s.graph.requests.find((r) => r.path.endsWith("/media"))!;
    assertEquals([upload.body?.messaging_product, upload.body?.type], [
      "whatsapp",
      "application/pdf",
    ]);
    const sent = s.graph.sent(CARLA).at(-1)!;
    const doc = sent.document as { id: string; filename: string; caption: string };
    assertEquals(sent.type, "document");
    assert(doc.id.startsWith("media.up."));
    assertEquals([doc.filename, doc.caption], ["ticket.pdf", "Here's your PIX code."]);
  });
});

test("a route's picture goes as a link signed with its params, which the route checks", async () => {
  await setup(async (s) => {
    await open(s);
    await write(s, "show me the card");
    const sent = s.graph.sent(CARLA).find((b) => b.type === "image")!;
    const picture = sent.image as { link: string; caption?: string };
    assert(picture.link.startsWith(`${ORIGIN}/media/trip-card?`), picture.link);
    // The answer goes with it, as its caption.
    assertEquals(picture.caption, "heard **Carla: show me the card**".replaceAll("**", "*"));
    const drawn = await s.serve(local(picture.link));
    assertEquals([drawn.status, await drawn.text()], [200, "card 123"]);
    const forged = local(picture.link.replace("trip=123", "trip=999"));
    assertEquals((await s.serve(forged)).status, 403);
  }, { plugins: [linked, cards] });
});

test("a carousel's pictures are links: a file with nowhere to link it sends the fallback", async () => {
  await setup(async (s) => {
    await open(s);
    await write(s, "any trips?");
    assertEquals(s.graph.requests.filter((r) => r.body?.interactive).length, 0);
    assertEquals(s.graph.texts(CARLA), ["heard *Carla: any trips?*\n\n1. 10:30\n2. 12:00"]);
  }, { plugins: [cards] });
});

test("a file goes only to whom may read it: one of another chat is neither linked nor uploaded", async () => {
  await setup(async (s) => {
    const file = await sendFile(s, "image/png");
    // Another customer's chat, where a View names Carla's file.
    await s.deliver([{ text: { body: "hi" } }], { from: "14155550123", name: "Dani" });
    const theirs = (await threadsOf(s.runtime, s.launch)).find((t) => t.title === "Dani")!;
    const before = s.graph.sent("14155550123").length;
    await s.runtime.call("test.show", { thread: theirs._id, file });
    await s.runtime.idle();
    const sent = s.graph.sent("14155550123").slice(before);
    assertEquals(sent.map((b) => b.type), ["text"]);
    assertEquals(
      (sent[0].text as { body: string }).body,
      "Here it is.\n\n(the picture isn't yours to see)",
    );
  }, { plugins: [linked, shows] });
});
