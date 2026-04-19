import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createCollectionsManager } from "@/database/collections/index.ts";
import { createDatabase } from "@/database/index.ts";
import messageCollection from "@/resources/collections/message.ts";
import participantCollection from "@/resources/collections/participant.ts";
import {
  createMessageService,
} from "@/runtime/collections/native.ts";

Deno.test("collection-backed message create does not write graph edges", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const manager = createCollectionsManager(db, [
    participantCollection,
    messageCollection,
  ]);

  const participantCollectionScoped = manager.withNamespace("global").participant as any;
  
  const messageService = createMessageService({
    collections: manager,
    ops: db.ops,
  });

  const participant = await participantCollectionScoped.upsertIdentity({
    externalId: "user-1",
    participantType: "human",
    name: "User 1",
  });

  const created = await messageService.create({
    threadId: "thread-1",
    senderId: participant.id,
    senderType: "user",
    content: "hello world",
    metadata: {},
  });

  assertEquals(created.threadId, "thread-1");
  assertEquals(created.senderId, participant.id);
  assertEquals(created.content, "hello world");
});
