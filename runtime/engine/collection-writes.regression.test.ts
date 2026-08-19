import { assertEquals } from "@std/assert";

import type { CopilotzProcessorCapabilities } from "./index.ts";
import { createMessageRecord } from "./collection-writes.ts";

Deno.test("processor collection writes keep content and ownership inside the command transaction", async () => {
  let insideTransaction = false;
  let materializedInsideTransaction = false;
  let linkedInsideTransaction = false;
  const record = Object.freeze({
    id: "message-a",
    namespace: "tenant-content-transaction",
    threadId: "thread-a",
    senderId: "user-a",
    recipientIds: [],
    content: [{
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    }],
    metadata: {},
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  });
  const context = {
    namespace: "tenant-content-transaction",
    content: {
      materialize() {
        materializedInsideTransaction = insideTransaction;
        return Promise.resolve(record.content);
      },
      linkOwner() {
        linkedInsideTransaction = insideTransaction;
        return Promise.resolve();
      },
    },
    async transaction(input: {
      execute(scope: {
        collections: {
          message: {
            create(): Promise<{ record: typeof record }>;
          };
        };
      }): Promise<typeof record>;
    }) {
      insideTransaction = true;
      try {
        const value = await input.execute({
          collections: {
            message: {
              create: () => Promise.resolve({ record }),
            },
          },
        });
        return {
          value,
          writes: [],
          dispatch: { handles: [], failures: [] },
        };
      } finally {
        insideTransaction = false;
      }
    },
  } as unknown as CopilotzProcessorCapabilities;

  await createMessageRecord(context, {
    id: "message-a",
    threadId: "thread-a",
    senderId: "user-a",
    recipientIds: [],
    content: [],
  }, { operationKey: "message-a:create" });

  assertEquals(materializedInsideTransaction, true);
  assertEquals(linkedInsideTransaction, true);
});
