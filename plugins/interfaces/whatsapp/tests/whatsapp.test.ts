/**
 * WhatsApp, against a fake Graph API: connecting a number (its managers
 * only, its credentials out of every event and reader), the webhook (Meta's
 * signature first, its verify handshake), strangers told how to link once
 * a day, linking by code, messages to agents as their person and answers
 * back, Meta's retries, media, long answers, commands, an agent waiting on
 * the person, someone who left, and a token Meta refuses.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Actor } from "../../../../runtime/mod.ts";
import type { Message } from "../../../agents/chat/mod.ts";
import { test } from "../../../../testing/mod.ts";
import type { WhatsAppNumber, WhatsAppPhone } from "../mod.ts";
import { sign } from "../shared/signature.ts";
import { toWhatsApp } from "../shared/text.ts";
import {
  ana,
  ANA_PHONE,
  bob,
  BOB_PHONE,
  link,
  logged,
  PARAGRAPH,
  PHONE_ID,
  said,
  SECRET,
  setup,
  STRANGER,
  threadsOf,
  TOKEN,
} from "./setup.ts";

test("connecting a number: its managers only, its token tried, its credentials out of sight", async () => {
  await setup(async ({ runtime, launch, number, read, bobJoins }) => {
    await bobJoins();
    const connect = (actor: Actor, input: Record<string, unknown>) =>
      runtime.call("whatsapp.connect", {
        in: launch,
        phoneId: "222222",
        token: TOKEN,
        secret: SECRET,
        ...input,
      }, { actor });
    await assertRejects(() => connect(bob, {}), Error, "Only those who manage this space");
    await assertRejects(
      () => runtime.call("whatsapp.webhook", { number }, { actor: bob }),
      Error,
      "Only those who manage this space",
    );
    // A token Meta refuses: nothing is connected. The same number twice: no.
    await assertRejects(
      () => connect(ana, { phoneId: "333333", token: "EAAG-not-the-right-token-000" }),
      Error,
      "Meta didn't accept",
    );
    await assertRejects(() => connect(ana, { phoneId: PHONE_ID }), Error, "connected already");
    // Members read what Meta says it is; nobody outside reads its credentials.
    const [shown] = await read<WhatsAppNumber>("whatsapp_number", bob);
    assertEquals([shown.phone, shown.name, shown.in], ["+1 555-0100", "Example Support", launch]);
    const secrets = JSON.stringify([
      await read("whatsapp_secret", bob),
      await read("whatsapp_secret", ana),
    ]);
    assert(!secrets.includes(TOKEN) && !secrets.includes(SECRET), secrets);
    assertEquals(await read("whatsapp_number", { kind: "person", id: "carol" }), []);
    // Its managers see where its webhook is.
    const webhook = await runtime.call<{ path: string; verify: string }>("whatsapp.webhook", {
      number,
    }, { actor: ana });
    assertEquals(webhook.path, `/hooks/whatsapp/${number}`);
    assert(webhook.verify.length >= 20);
    // Connecting one and disconnecting it: the log never has its credentials.
    const log = await logged(runtime, async () => {
      const { number: other } = await connect(ana, {}) as { number: string };
      await runtime.call("whatsapp.disconnect", { number: other }, { actor: ana });
    });
    assert(log.includes("whatsapp_number.created") && log.includes("whatsapp_number.deleted"));
    assert(!log.includes(TOKEN) && !log.includes(SECRET), log);
  });
});

test("the webhook: Meta's verify handshake, and its signature checked before anything else", async () => {
  await setup(async ({ runtime, serve, number, verify, deliver, graph }) => {
    const hook = `http://localhost/hooks/whatsapp/${number}`;
    const handshake = await serve(
      new Request(`${hook}?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=42xyz`),
    );
    assertEquals([handshake.status, await handshake.text()], [200, "42xyz"]);
    const wrong = await serve(
      new Request(`${hook}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42xyz`),
    );
    assertEquals(wrong.status, 403);
    assertEquals((await serve(new Request("http://localhost/hooks/whatsapp/nope"))).status, 404);
    // Unsigned, or signed with another secret: refused, and nothing on record.
    const log = await logged(runtime, async () => {
      const unsigned = await serve(
        new Request(hook, {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        }),
      );
      assertEquals(unsigned.status, 401);
      const forged = await deliver([{ text: { body: "hi" } }], {
        secret: "not-the-app-secret-000",
      });
      assertEquals(forged.status, 401);
    });
    assertEquals(log, "[]");
    assertEquals(graph.requests.filter((r) => r.method === "POST").length, 0);
  });
});

test("a stranger is told how to link, once a day, and nothing else", async () => {
  await setup(async ({ runtime, graph, deliver, launch, personal }) => {
    assertEquals((await deliver([{ text: { body: "hello?" } }], { from: STRANGER })).status, 200);
    await deliver([{ text: { body: "anyone?" } }], { from: STRANGER });
    const told = graph.texts(STRANGER);
    assertEquals(told.length, 1);
    assert(told[0].includes("link this phone") && told[0].includes("https://app.test"));
    assertEquals(await threadsOf(runtime, launch), []);
    assertEquals(await threadsOf(runtime, personal), []);
  });
});

test("a code links a phone to its person, once; wrong ones don't, and guessing stops", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, number, read } = s;
    const { code, phone } = await runtime.call<{ code: string; phone: string }>(
      "whatsapp.link",
      { number },
      { actor: ana },
    );
    assertEquals([code.length, phone], [6, "+1 555-0100"]);
    // She sees her code; nobody else does. Bob isn't in Launch: no code for him.
    assertEquals((await read<{ code: string }>("whatsapp_code", ana)).map((c) => c.code), [code]);
    assertEquals(await read("whatsapp_code", bob), []);
    await assertRejects(() => runtime.call("whatsapp.link", { number }, { actor: bob }));
    // Guessing: five tries answered, then silence.
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 7; i++) await deliver([{ text: { body: wrong } }], { from: STRANGER });
    assertEquals(graph.texts(STRANGER).filter((t) => t.includes("didn't match")).length, 5);
    // From Ana's phone, the code links it, written any way.
    await deliver([{ text: { body: `link ${code.slice(0, 3)} ${code.slice(3)}` } }]);
    const [welcome] = graph.texts(ANA_PHONE);
    assert(welcome.startsWith("You're linked, Ana!") && welcome.includes("*Personal*"), welcome);
    const [mine] = await read<WhatsAppPhone>("whatsapp_phone", ana);
    assertEquals([mine.person, mine.phone, mine.name], ["ana", ANA_PHONE, "Ana"]);
    assertEquals(await read("whatsapp_phone", bob), []);
    assertEquals(await read("whatsapp_code", ana), []);
    // It worked once.
    await deliver([{ text: { body: code } }], { from: "14155550999" });
    assert(graph.texts("14155550999")[0].includes("didn't match"));
    // Unlinked from the app: a stranger again.
    await runtime.call("whatsapp.unlink", { number }, { actor: ana });
    await deliver([{ text: { body: "hi" } }]);
    assert(graph.texts(ANA_PHONE).at(-1)!.includes("link this phone"));
  });
});

test("a linked phone's message reaches the agents as its person, and their answer goes back", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, personal } = s;
    await link(s);
    const before = graph.requests.length;
    await deliver([{ text: { body: "hello there" } }]);
    // It went to Ana's Personal space, as her, in a conversation of its own.
    const [thread] = await threadsOf(runtime, personal);
    assertEquals(await said(runtime, thread._id), [
      ["ana", "hello there"],
      ["lead", "heard **ana: hello there**"],
    ]);
    // Read, typing, and the answer, as WhatsApp formats it.
    const after = graph.requests.slice(before).map((r) => r.body);
    assertEquals([after[0]?.status, after[0]?.typing_indicator], ["read", { type: "text" }]);
    assertEquals(graph.texts(ANA_PHONE).at(-1), "heard *ana: hello there*");
    // Her message isn't marked as drawing on the number's space.
    const [mine] = await runtime.query<Message[]>("message.history", { thread: thread._id }, {
      actor: ana,
    });
    assertEquals(mine.drew, undefined);
    // The next message goes on in that conversation.
    await deliver([{ text: { body: "and more" } }]);
    assertEquals((await threadsOf(runtime, personal)).length, 1);
    assertEquals(graph.texts(ANA_PHONE).at(-1), "heard *ana: and more*");
  });
});

test("Meta delivering a message again changes nothing", async () => {
  await setup(async (s) => {
    const { runtime, graph, serve, number, personal } = s;
    await link(s);
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: PHONE_ID },
            messages: [{ id: "wamid.same", from: ANA_PHONE, type: "text", text: { body: "once" } }],
          },
        }],
      }],
    });
    const signature = await sign(SECRET, new TextEncoder().encode(body));
    for (let i = 0; i < 3; i++) {
      const answered = await serve(
        new Request(`http://localhost/hooks/whatsapp/${number}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
          body,
        }),
      );
      assertEquals(answered.status, 200);
      await runtime.idle();
    }
    const [thread] = await threadsOf(runtime, personal);
    assertEquals((await said(runtime, thread._id)).length, 2);
    assertEquals(graph.texts(ANA_PHONE).filter((t) => t.includes("once")).length, 1);
  });
});

test("photos, documents and voice notes come as files; a voice note is transcribed", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, personal } = s;
    await link(s);
    await deliver([{
      type: "image",
      image: { id: "media-photo", mime_type: "image/jpeg", caption: "our logo" },
    }]);
    await deliver([{
      type: "document",
      document: { id: "media-doc", mime_type: "application/pdf", filename: "plan.pdf" },
    }]);
    await deliver([{
      type: "audio",
      audio: { id: "media-voice", mime_type: "audio/ogg; codecs=opus", voice: true },
    }]);
    await deliver([{ type: "video", video: { id: "media-huge", mime_type: "video/mp4" } }]);
    await deliver([{ type: "reaction", reaction: { emoji: "👍" } }]);
    const [thread] = await threadsOf(runtime, personal);
    const mine = (await runtime.query<Message[]>("message.history", { thread: thread._id }, {
      actor: ana,
    })).filter((m) => m.from === "ana");
    assertEquals(mine.map((m) => [m.text, m.files?.map((f) => [f.name, f.type, f.size])]), [
      ["our logo", [["photo.jpg", "image/jpeg", 6]]],
      ["", [["plan.pdf", "application/pdf", 13]]],
      ["", [["voice-note.ogg", "audio/ogg; codecs=opus", 64]]],
    ]);
    assert(mine[2].files?.[0].transcript?.startsWith("(A recording,"));
    const texts = graph.texts(ANA_PHONE);
    assert(texts.some((t) => t.includes("over 10 MB")));
    assert(texts.at(-1)!.includes("can't pass that kind of message on"));
  });
});

test("a long answer goes in parts, each within WhatsApp's limit, as WhatsApp formats it", async () => {
  await setup(async (s) => {
    const { graph, deliver } = s;
    await link(s);
    await deliver([{ text: { body: "something long, please" } }]);
    const parts = graph.texts(ANA_PHONE).slice(1);
    assert(parts.length >= 3, `${parts.length} parts`);
    assert(parts.every((p) => p.length <= 4096));
    assert(parts.every((p) => p.startsWith("*Note.*")));
    // Nothing lost, nothing added: cut between paragraphs.
    const whole = Array.from({ length: 6 }, () => PARAGRAPH.trim().replace("**Note.**", "*Note.*"));
    assertEquals(parts.join("\n\n"), whole.join("\n\n"));
  });
});

test("/new starts a new conversation; /space moves to another, by name", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, personal, launch, number } = s;
    await link(s);
    const last = () => graph.texts(ANA_PHONE).at(-1)!;
    await deliver([{ text: { body: "first" } }]);
    await deliver([{ text: { body: "/new" } }]);
    assert(last().startsWith("Starting fresh"));
    await deliver([{ text: { body: "second" } }]);
    assertEquals((await threadsOf(runtime, personal)).length, 2);
    await deliver([{ text: { body: "/space" } }]);
    assertEquals(
      last(),
      "You're talking in *Personal*.\nYour spaces: Personal, Launch.\n\nSend /space <name> to switch.",
    );
    await deliver([{ text: { body: "/space nowhere" } }]);
    assert(last().startsWith('No space called "nowhere"'));
    await deliver([{ text: { body: "/space laun" } }]);
    assert(last().startsWith("Now talking in *Launch*"));
    await deliver([{ text: { body: "in launch" } }]);
    const [there] = await threadsOf(runtime, launch);
    assertEquals(await said(runtime, there._id), [
      ["ana", "in launch"],
      ["lead", "heard **ana: in launch**"],
    ]);
    // From the app too.
    await runtime.call("whatsapp.move", { number, space: personal }, { actor: ana });
    await deliver([{ text: { body: "back home" } }]);
    assertEquals((await threadsOf(runtime, personal)).length, 3);
    await deliver([{ text: { body: "/help" } }]);
    assert(last().includes("/space <name>"));
    // Not a command: a message like any other.
    await deliver([{ text: { body: "/etc/hosts is broken" } }]);
    assert(last().includes("/etc/hosts is broken"));
  });
});

test("an agent waiting on the person: their answer from WhatsApp is the reply it waits for", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, personal } = s;
    await link(s);
    await deliver([{ text: { body: "please ask me something" } }]);
    // The question reached her phone.
    assertEquals(graph.texts(ANA_PHONE).at(-1), "Which color?");
    await deliver([{ text: { body: "blue" } }]);
    const [thread] = await threadsOf(runtime, personal);
    const history = await runtime.query<Message[]>("message.history", { thread: thread._id }, {
      actor: ana,
    });
    const question = history.find((m) => m.text === "Which color?")!;
    const answer = history.find((m) => m.text === "blue")!;
    // Her answer is the reply the agent waited for: its turn went on with it.
    assertEquals(answer.replyTo, question._id);
    assertEquals(answer.to, ["lead"]);
    const last = history.at(-1)!;
    assertEquals([last.from, last.turn !== undefined], ["lead", true]);
    assertEquals(graph.texts(ANA_PHONE).at(-1), toWhatsApp(last.text ?? ""));
  });
});

test("someone who left the number's space is unlinked, and told why", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, launch, bobJoins } = s;
    await bobJoins();
    await link(s, bob, BOB_PHONE);
    assert(graph.texts(BOB_PHONE)[0].startsWith("You're linked"));
    await runtime.call("space.leave", { space: launch }, { actor: bob });
    await deliver([{ text: { body: "still there?" } }], { from: BOB_PHONE });
    assert(graph.texts(BOB_PHONE).at(-1)!.startsWith("You're no longer in the space"));
    assertEquals(await runtime.query("thread.recent", {}, { actor: bob }), []);
    // A stranger now.
    await deliver([{ text: { body: "hello" } }], { from: BOB_PHONE });
    assert(graph.texts(BOB_PHONE).at(-1)!.includes("link this phone"));
  });
});

test("a token Meta refuses is noted on the number, until it's replaced", async () => {
  await setup(async (s) => {
    const { runtime, deliver, number, read, personal } = s;
    await link(s);
    await runtime.call("test.expire", {});
    await deliver([{ text: { body: "hi" } }]);
    // Her message reached the agents; their answer couldn't go out, and its managers see why.
    const [thread] = await threadsOf(runtime, personal);
    assertEquals((await said(runtime, thread._id)).length, 2);
    const [shown] = await read<WhatsAppNumber>("whatsapp_number", ana);
    assert(shown.problem?.includes("refused its access token"));
    await runtime.call("whatsapp.credentials", { number, token: TOKEN }, { actor: ana });
    const [fixed] = await read<WhatsAppNumber>("whatsapp_number", ana);
    assertEquals(fixed.problem, undefined);
  });
});
