import { provisionOperationCatalog } from "../streams/catalog.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import { hostIngressProof } from "../application/ingress/authority.ts";
import { testAuthority } from "../testing/authority.ts";
import {
  type AuthorityUpgradeManifest,
  inspectAuthorityUpgrade,
  upgradeAuthoritySchema,
} from "./upgrade.ts";
import { retainedInvocationDigest } from "./migration.ts";

Deno.test("F4 version 13 offline upgrade validates every retained binding and preserves capture bytes", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `authority_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const store = createEventStore({ session: db, schema });
  const source = await store.commitMutation({
    draft: {
      namespace: "space",
      type: "request",
      payload: {
        dataRef: {
          eventBodyId: "source",
          schemaVersion: 1,
          mediaType: "application/json",
        },
      },
    },
    body: { id: "source", json: { requested: true } },
    consumers: [],
    ingress: hostIngressProof(),
  });
  await store.commitMutation({
    draft: {
      namespace: "space",
      type: "fixture.invoked",
      metadata: { sourceEventId: source.event.id },
      payload: {
        dataRef: {
          eventBodyId: "capture",
          schemaVersion: 1,
          mediaType: "application/json",
        },
      },
    },
    body: {
      id: "capture",
      json: {
        status: "invoked",
        actionId: "fixture",
        actionRunId: "run",
        input: { original: true },
      },
    },
    consumers: [],
  });
  const run = createSchemaCommandRunner(db, schema);
  await run("fixture.receipt", {}, async (_, { transaction }) => {
    await transaction.query(
      `INSERT INTO "${schema}".owner_receipts(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,'runtime','action.protected-input',$2::jsonb,$3::jsonb)`,
      [
        JSON.stringify(["action.protected-input", "space", "run"]),
        JSON.stringify({
          databaseSchema: schema,
          namespace: "space",
          actionId: "fixture",
          inputSchema: null,
          publicRevisionFields: [],
        }),
        JSON.stringify({
          source: { eventId: source.event.id },
          request: { original: true },
        }),
      ],
    );
  });
  await store.commitMutation({
    draft: {
      namespace: "space",
      type: "copilotz.server.action.requested",
      payload: { queued: true },
    },
    consumers: [],
  });
  const owner = await openDatabaseOwner(db, schema);
  await releaseDatabaseOwner(owner);
  // Close all owner references before the explicit offline upgrade.
  owner.stop();
  try {
    await db.query(
      `UPDATE "${schema}".copilotz_schema_metadata SET version=12`,
    );
    for (
      const table of [
        "authorization_sessions",
        "authorization_channels",
        "authorization_invocations",
      ]
    ) await db.query(`DROP TABLE "${schema}".${table}`);
    const inventory = await inspectAuthorityUpgrade(db, schema);
    const before = await db.query(
      `SELECT event_body_id,body,digest FROM "${schema}".event_bodies ORDER BY event_body_id`,
    );
    const authority = {
      ...testAuthority(schema),
      provenance: { ingress: "core" as const, source: source.event.id },
    };
    const manifest: AuthorityUpgradeManifest = {
      policies: [{ id: "fixture", revision: "1" }],
      invocations: await Promise.all(
        inventory.invocations.map(async (invocation) => ({
          databaseSchema: schema,
          namespace: invocation.namespace,
          runId: invocation.runId,
          expectedDigest: await retainedInvocationDigest(invocation),
          authority,
        })),
      ),
      events: inventory.events.map((event) => ({
        ...event,
        authority,
        ...(event.unclassified ? { ingress: { kind: "host" as const } } : {}),
      })),
    };
    await assertRejects(() => upgradeAuthoritySchema(db, schema), Error);
    assertEquals(
      Number(
        (await db.query<{ version: number }>(
          `SELECT version FROM "${schema}".copilotz_schema_metadata`,
        )).rows[0].version,
      ),
      12,
    );
    await assertRejects(
      () =>
        upgradeAuthoritySchema(db, schema, {
          ...manifest,
          events: manifest.events.map((event) => ({
            ...event,
            digest: "changed",
          })),
        }),
      Error,
    );
    await assertRejects(() =>
      upgradeAuthoritySchema(db, schema, {
        ...manifest,
        events: manifest.events.map(({ ingress: _ingress, ...event }) => event),
      })
    );
    await assertRejects(() =>
      upgradeAuthoritySchema(db, schema, {
        ...manifest,
        events: manifest.events.map((event) =>
          event.unclassified
            ? {
              ...event,
              ingress: {
                kind: "authenticated-server",
                actor: { id: "substitute" },
              },
            }
            : event
        ),
      })
    );
    await upgradeAuthoritySchema(db, schema, manifest);
    await upgradeAuthoritySchema(db, schema, manifest);
    assertEquals(
      Number(
        (await db.query<{ version: number }>(
          `SELECT version FROM "${schema}".copilotz_schema_metadata`,
        )).rows[0].version,
      ),
      13,
    );
    assertEquals(
      (await db.query(
        `SELECT event_body_id,body,digest FROM "${schema}".event_bodies ORDER BY event_body_id`,
      )).rows,
      before.rows,
    );
    assertEquals(
      (await db.query<{ authority: unknown }>(
        `SELECT authority FROM "${schema}".authorization_invocations`,
      )).rows[0].authority,
      authority,
    );
    await assertRejects(
      () => db.query(`UPDATE "${schema}".events SET metadata='{}'`),
      Error,
      "immutable",
    );
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});

for (const principalKind of ["session", "api-key"] as const) {
  Deno.test(`F4 upgrade keeps reviewed actor separate from ${principalKind} principal and preserves provenance`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    });
    const schema = `actor_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const store = createEventStore({ session: db, schema });
    const actor = {
      id: "human-participant",
      externalId: "login-identity",
      name: "Member",
    };
    const { authenticatedServerIngressProof } = await import(
      "../application/ingress/authority.ts"
    );
    for (const classified of [false, true]) {
      await store.commitMutation({
        draft: {
          namespace: "space",
          type: "copilotz.server.action.requested",
          payload: { classified },
          metadata: { source: "original" },
        },
        consumers: [],
        ...(classified
          ? { ingress: authenticatedServerIngressProof(actor) }
          : {}),
      });
    }
    const owner = await openDatabaseOwner(db, schema);
    await releaseDatabaseOwner(owner);
    owner.stop();
    try {
      await db.query(
        `UPDATE "${schema}".copilotz_schema_metadata SET version=12`,
      );
      const inventory = await inspectAuthorityUpgrade(db, schema);
      const before = (await db.query(
        `SELECT id,metadata,payload FROM "${schema}".events ORDER BY id`,
      )).rows;
      const authority = {
        ...testAuthority(schema, "space", "credential-id"),
        principal: { kind: principalKind, id: "credential-id" },
        authorityBasis: {
          kind: principalKind === "session"
            ? "session" as const
            : "credential" as const,
          id: "credential-id",
        },
        requestFacts: {
          ...testAuthority(schema).requestFacts,
          transport: "http" as const,
        },
        provenance: {
          ingress: "http" as const,
          source: "exact-reviewed-source",
        },
      };
      const manifest: AuthorityUpgradeManifest = {
        policies: [{ id: "fixture", revision: "1" }],
        invocations: [],
        events: inventory.events.map((event) => ({
          ...event,
          authority,
          actorBinding: actor,
          ...(event.unclassified
            ? { ingress: { kind: "authenticated-server" as const, actor } }
            : {}),
        })),
      };
      for (
        const actorBinding of [undefined, { ...actor, id: "other" }, {
          ...actor,
          name: "changed",
        }]
      ) {
        for (const reviewed of manifest.events) {
          await assertRejects(
            () =>
              upgradeAuthoritySchema(db, schema, {
                ...manifest,
                events: manifest.events.map((
                  { actorBinding: _binding, ...event },
                ) =>
                  event.eventId === reviewed.eventId
                    ? ({ ...event, ...(actorBinding ? { actorBinding } : {}) })
                    : ({ ...event, actorBinding: actor })
                ),
              }),
            Error,
            "exact reviewed actor binding",
          );
        }
      }
      await assertRejects(
        () =>
          upgradeAuthoritySchema(db, schema, {
            ...manifest,
            events: manifest.events.map((event) => ({
              ...event,
              authority: {
                ...authority,
                authorityBasis: { ...authority.authorityBasis, id: actor.id },
              },
            })),
          }),
        TypeError,
        "credential basis",
      );
      await upgradeAuthoritySchema(db, schema, manifest);
      await upgradeAuthoritySchema(db, schema, manifest);
      assertEquals(
        (await db.query(
          `SELECT id,metadata,payload FROM "${schema}".events ORDER BY id`,
        )).rows,
        before,
      );
      const rows = (await db.query<{ owner_ingress: unknown }>(
        `SELECT owner_ingress FROM "${schema}".events`,
      )).rows;
      assertEquals(
        rows.map((row) => row.owner_ingress),
        rows.map(() => ({ kind: "authenticated-server", actor, authority })),
      );
      assertEquals(
        (await db.query(
          `SELECT count(*)::int AS n FROM "${schema}".owner_receipts WHERE kind='authorization.upgrade'`,
        )).rows,
        [{ n: 1 }],
      );
    } finally {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}
