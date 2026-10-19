import { assertEquals } from "@std/assert";
import { createCopilotz } from "../../../../../create-copilotz.ts";
import { createCopilotzClient } from "../../../../../client/index.ts";
import { defineCollection } from "@copilotz/copilotz/collections/authoring";
import { definePlugin } from "@copilotz/copilotz/authoring";
import { createTestDatabase } from "../../../../../runtime/testing/ominipg.ts";
import { serverPlugin } from "../../../../server/plugin.ts";
import { defineServerFacade } from "../../../../server/resources/facade/index.ts";
import type { HttpHandlerContext } from "../../../../server/authoring/http-adapter/index.ts";
import {
  participantDisplayInputSchema,
  participantDisplayOutputSchema,
  readParticipantDisplays,
} from "./participant-display.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "PostgreSQL display batches preserve escaped Unicode IDs through named queries",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url: url!, pgPoolMax: 4 });
    const schema = `display_${crypto.randomUUID().replaceAll("-", "")}`;
    const calls: unknown[] = [];
    const app = await createCopilotz({
      database: db,
      databaseSchema: schema,
      namespace: "scope",
      collections: {
        participant: defineCollection({
          name: "displayParticipant",
          schema: { type: "object", properties: { name: { type: "string" } } },
          queries: {
            display: {
              inputSchema: participantDisplayInputSchema,
              outputSchema: participantDisplayOutputSchema,
              select({ input }) {
                calls.push(input);
                return (input.participantIds as string[]).map((id) => ({
                  id,
                  externalId: id,
                  namespace: "scope",
                  participantType: "human",
                  metadata: {},
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                }));
              },
            },
          },
        }),
      },
      plugins: [definePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: defineServerFacade({
              expose: {
                actions: false,
                collections: {
                  include: ["displayParticipant"],
                  operations: { include: ["query:display"] },
                },
                channels: false,
              },
              authenticate() {
                return {
                  databaseSchema: schema,
                  namespace: "scope",
                  actor: { id: "member" },
                  context: {
                    viewer: {
                      kind: "session",
                      subject: "member",
                      expiresAt: 9999999999,
                    },
                  },
                };
              },
              authorize() {
                return {};
              },
            }),
          },
        },
      })],
    });
    const client = createCopilotzClient({
      baseUrl: "http://fixture.test/api",
      fetch: (input, init) => app.fetch(new Request(input, init)),
    });
    try {
      const context = {
        scope: { namespace: "scope" },
        read: {
          async query(
            _collection: string,
            name: string,
            input: Record<string, unknown>,
          ) {
            const result = await client.collections.query(
              "displayParticipant",
              name,
              input,
            );
            if (
              !result || typeof result !== "object" || !("data" in result) ||
              !Array.isArray(result.data)
            ) {
              throw new Error("Expected query data.");
            }
            return result.data;
          },
        },
      } as unknown as HttpHandlerContext;
      // Escaped controls maximize JSON bytes; astral Unicode exercises UTF-8 accounting.
      for (const character of ["\u0001", "🌲"]) {
        const ids = Array.from(
          { length: 17 },
          (_, i) => `${character.repeat(510)}${String(i).padStart(2, "0")}`,
        );
        const rows = await readParticipantDisplays(
          context,
          "display",
          {
            id: character.repeat(512),
            namespace: "scope",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          ids,
          "participants",
        );
        assertEquals(rows.map((row) => row.id), ids);
      }
      assertEquals(calls.length, 10);
    } finally {
      await app.close();
      await db.close();
    }
  },
});
