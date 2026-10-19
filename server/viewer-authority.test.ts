import { assert, assertEquals } from "@std/assert";
import { createCopilotz } from "../create-copilotz.ts";
import { defineCollection } from "../runtime/collections/definition.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { serverPlugin } from "../plugins/server/plugin.ts";
import { defineServerFacade } from "../plugins/server/resources/facade/index.ts";

Deno.test("HTTP viewer authority requires both successful host hooks and cannot be forged by request claims", async (test) => {
  for (
    const mode of [
      "missing-authenticate",
      "missing-authorize",
      "failed-authenticate",
      "failed-authorize",
      "undefined-authenticate",
      "undefined-authorize",
      "forged-request",
    ]
  ) {
    await test.step(mode, async () => {
      const db = await createTestDatabase({
        url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
        pgPoolMax: 4,
      });
      const schema = `viewer_negative_${
        crypto.randomUUID().replaceAll("-", "")
      }`;
      let viewerInvocations = 0;
      const claims = {
        kind: "session",
        subject: "member",
        expiresAt: 9999999999,
      };
      const forged = {
        actor: { id: "member" },
        context: { viewer: claims },
        serverScope: {
          namespace: "space",
          databaseSchema: schema,
          actor: { id: "member" },
          context: { viewer: claims },
        },
      };
      const app = await createCopilotz({
        database: db,
        databaseSchema: schema,
        namespace: "space",
        collections: {
          entry: defineCollection({
            name: "viewerEntry",
            ownerPolicy: "required",
            schema: {
              type: "object",
              properties: { value: { type: "string" } },
            } as const,
          }),
        },
        collectionPolicies: {
          entry: {
            authorize(_intent, context) {
              if (context.invocation.kind === "viewer") viewerInvocations++;
            },
          },
        },
        plugins: [
          definePlugin({
            ...serverPlugin,
            resources: {
              server: {
                default: defineServerFacade({
                  expose: {
                    actions: false,
                    collections: {
                      include: ["viewerEntry"],
                      operations: { include: ["get", "observe"] },
                    },
                    channels: false,
                  },
                  ...(mode === "missing-authenticate" ? {} : {
                    authenticate() {
                      if (mode === "failed-authenticate") {
                        return new Response("Denied", { status: 401 });
                      }
                      if (mode === "undefined-authenticate") {
                        return undefined as never;
                      }
                      return {
                        namespace: "space",
                        databaseSchema: schema,
                        actor: { id: "member" },
                        ...(mode === "forged-request"
                          ? {}
                          : { context: { viewer: claims } }),
                      };
                    },
                  }),
                  ...(mode === "missing-authorize" ? {} : {
                    authorize() {
                      if (mode === "failed-authorize") {
                        return new Response("Denied", { status: 403 });
                      }
                      return mode === "undefined-authorize"
                        ? undefined as never
                        : {};
                    },
                  }),
                }),
              },
            },
          }),
        ],
      });
      try {
        const headers = {
          "content-type": "application/json",
          "x-actor": JSON.stringify(forged.actor),
          "x-viewer": JSON.stringify(claims),
          "x-server-scope": JSON.stringify(forged.serverScope),
        };
        const query = new URLSearchParams({
          actor: JSON.stringify(forged.actor),
          context: JSON.stringify(forged.context),
          serverScope: JSON.stringify(forged.serverScope),
        });
        const record = await app.fetch(
          new Request(
            `http://fixture.test/api/collections/viewerEntry/one?${query}`,
            { headers },
          ),
        );
        assert(
          record.status >= 400,
          `${mode}: forged record request must fail`,
        );
        await record.text();
        for (const selector of [{ id: "one" }, { id: "one", ...forged }]) {
          const observed = await app.fetch(
            new Request(
              "http://fixture.test/api/collections/viewerEntry/observe",
              {
                method: "POST",
                headers,
                body: JSON.stringify(selector),
              },
            ),
          );
          assert(observed.status >= 400, `${mode}: observation must fail`);
          assert(!(await observed.text()).includes("collection.snapshot"));
        }
        assertEquals(
          viewerInvocations,
          0,
          `${mode}: no viewer invocation may be minted`,
        );
      } finally {
        await app.close();
        await db.close();
      }
    });
  }
});
