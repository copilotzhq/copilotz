/**
 * A customer writing on WhatsApp brings their archived chat back: what they
 * send goes to the chat it went to before (inside the line's gap), and the
 * chat is listed again for the space's people, with the answer.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import type { Thread } from "../chat/mod.ts";
import { ana, said, setup, threadsOf } from "../../interfaces/whatsapp/tests/setup.ts";

const CARLA = "5511911112222";

test("a customer's WhatsApp message brings their archived chat back", async () => {
  await setup(async (s) => {
    await s.runtime.call("whatsapp.set", { number: s.number, open: true }, { actor: ana });
    await s.deliver([{ text: { body: "where's my order?" } }], { from: CARLA, name: "Carla" });
    const [chat] = await threadsOf(s.runtime, s.launch);
    assert(chat, "her chat");
    await s.runtime.call("chat.archive", { thread: chat._id, archived: true }, { actor: ana });
    assertEquals(await threadsOf(s.runtime, s.launch), []);
    await s.deliver([{ text: { body: "any news?" } }], { from: CARLA, name: "Carla" });
    const listed = await threadsOf(s.runtime, s.launch);
    assertEquals(listed.map((t) => t._id), [chat._id]);
    assertEquals((listed[0] as Thread).archived, undefined);
    assert((await said(s.runtime, chat._id)).some(([, text]) => text === "any news?"));
  });
});
