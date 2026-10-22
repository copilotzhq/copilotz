import { assert, assertEquals } from "@std/assert";
import { createCopilotzApplication } from "../runtime/application/application.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { testAuthority } from "../runtime/testing/authority.ts";
import { testSecretAdapter } from "../runtime/testing/secret-adapter.ts";
import { defineAction } from "../runtime/actions/index.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { corePlugin } from "../plugins/core/plugin.ts";
import { coreHttpPlugin } from "../plugins/core-http/index.ts";
import { defineServerFacade, serverPlugin } from "../plugins/server/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";

Deno.test("native session actor authorizes Core assets and missing actors return 403", async () => {
  const database = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `actor_${crypto.randomUUID().replaceAll("-", "")}`;
  let resolve = true;
  let allowedAsset = "";
  const seen: string[] = [];
  const facade = defineServerFacade({
    expose: {
      actions: { include: ["login"] },
      collections: false,
      channels: false,
    },
    authenticate: (request) => ({
      authority: testAuthority(
        schema,
        "main",
        request.headers.get("x-user") ?? "member",
      ),
    }),
    async resolveActor({ scope, read }) {
      seen.push(scope.authority.principal.kind);
      if (!resolve || scope.authority.principal.kind !== "session") {
        return undefined;
      }
      const rows = await read.list("participant", {
        where: { externalId: scope.authority.principal.id },
      });
      return rows[0] ? { id: rows[0].id } : undefined;
    },
  });
  const login = defineAction({
    id: "fixture.login",
    async execute(input, context) {
      await context.transaction(async (tx) => {
        await tx.sessions.create({
          principal: (input as { user: string }).user,
          maxAge: 3600,
        });
      });
      return { ok: true };
    },
  });
  const application = await createCopilotzApplication({
    database,
    databaseSchema: schema,
    namespace: "main",
    adapters: { secrets: { default: await testSecretAdapter() } },
    plugins: [
      corePlugin,
      coreHttpPlugin,
      definePlugin({
        ...serverPlugin,
        actions: { login },
        resources: { server: { default: facade } },
      }),
    ],
    authorization: {
      systemScopes: { main: testAuthority(schema, "main").scope },
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate({ authority }) {
            const actor = `participant:${authority.principal.id}`;
            return {
              actions: { login: {} },
              collections: {
                participant: {},
                message: {},
                thread: { contains: { participantIds: [actor] } },
              },
              operations: { metadata: {} },
              sessions: {
                create: { principal: authority.principal.id, maxAge: 3600 },
              },
              assets: { read: [allowedAsset] },
            };
          },
        },
      },
      actions: { login: { id: "fixture", revision: "1" } },
      collections: Object.fromEntries(
        Object.keys(corePlugin.collections).map((
          name,
        ) => [name, { id: "fixture", revision: "1" }]),
      ),
    },
  });
  const handler = createServerFacadeFetchHandler(application);
  async function signIn(user: string) {
    const headers = {
      "x-user": user,
      "content-type": "application/json",
      "idempotency-key": user,
      "x-copilotz-credential-proof": "a".repeat(64),
    };
    const accepted = await handler(
      new Request("https://test/api/actions/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ user }),
      }),
    );
    assertEquals(accepted.status, 202, await accepted.clone().text());
    const id = (await accepted.json()).data.operationId;
    for (let i = 0; i < 100; i++) {
      const response = await handler(
        new Request(`https://test/api/operations/${id}/result`, { headers }),
      );
      if (response.status !== 202) {
        assertEquals(response.status, 200, await response.clone().text());
        const cookie = response.headers.get("set-cookie");
        assert(cookie);
        return cookie.split(";")[0];
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Login did not settle.");
  }
  try {
    const records = application.host.collections;
    for (const user of ["member", "outsider"]) {
      await records.participant.create({
        id: `participant:${user}`,
        externalId: user,
        participantType: "human",
      });
    }
    await records.thread.create({
      id: "thread",
      participantIds: ["participant:member"],
    });
    const published = await application.content.assets.publish({
      namespace: "main",
      mediaType: "text/plain",
      body: new TextEncoder().encode("tool result"),
      idempotencyKey: "fixture-asset",
    });
    const message = await records.message.create({
      id: "message",
      threadId: "thread",
      senderId: "participant:member",
      content: [{
        assetId: published.id,
        kind: "text",
        role: "body",
        mediaType: published.mediaType,
      }],
      visibility: {
        kind: "participants",
        participantIds: ["participant:member"],
      },
    });
    const assetId = (message.content as { assetId: string }[])[0].assetId;
    assert(assetId);
    allowedAsset = assetId;
    const assetPath = `/threads/thread/messages/message/assets/${assetId}`;
    const member = await signIn("member");
    const outsider = await signIn("outsider");
    const get = (path: string, cookie?: string) =>
      handler(
        new Request(`https://test/api${path}`, {
          headers: cookie ? { cookie } : {},
        }),
      );
    const asset = await get(assetPath, member);
    assertEquals(asset.status, 200, await asset.clone().text());
    assertEquals(await asset.text(), "tool result");
    assertEquals((await get(assetPath, outsider)).status, 404);
    assertEquals(
      (await get(assetPath.replace("/message/", "/missing/"), member)).status,
      404,
    );
    assertEquals((await get("/threads/thread/messages", member)).status, 200);
    const withoutResolver = createServerFacadeFetchHandler(application, {
      facade: { ...facade, resolveActor: undefined },
    });
    const noResolver = await withoutResolver(
      new Request(`https://test/api${assetPath}`, {
        headers: { cookie: member },
      }),
    );
    assertEquals(noResolver.status, 403);
    assertEquals((await noResolver.json()).error.code, "actor_required");
    resolve = false;
    for (
      const cookie of [member, undefined, "__Host-copilotz_session=invalid"]
    ) {
      for (const path of [assetPath, "/threads/thread/messages"]) {
        const response = await get(path, cookie);
        assertEquals(response.status, 403, await response.clone().text());
        assertEquals((await response.json()).error.code, "actor_required");
      }
    }
    assert(seen.includes("session"));
    assert(seen.includes("api-key"));
  } finally {
    await application.close();
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
});
