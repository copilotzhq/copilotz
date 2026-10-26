/** Synthetic expansion of the real old-code v7 fixture. No production input. */
import { restoreRetainedFixture } from "./load.ts";
import { encodeEventBody } from "../../../runtime/events/body-store.ts";
import { digestContent } from "../../../runtime/content/digest.ts";
import type { SqlSession } from "../../../runtime/events/session.ts";
import { quoteEventIdentifier } from "../../../runtime/events/schema.ts";

export async function scaleRetainedFixture(
  db: SqlSession,
  schema: string,
  options: { events: number; bodyBytes: number; orphan?: boolean },
) {
  if (
    !Number.isSafeInteger(options.events) || options.events < 50 ||
    options.events % 50 !== 0 ||
    !Number.isSafeInteger(options.bodyBytes) || options.bodyBytes < 1 ||
    options.bodyBytes > 1048576
  ) {
    throw new RangeError(
      "Use a positive event count divisible by 50 and physical payloads of 1 byte to 1 MiB.",
    );
  }
  const original = await restoreRetainedFixture(db, schema);
  const q = quoteEventIdentifier(schema);
  const bodies = Math.ceil(options.events * 0.8);
  const assets = Math.ceil(options.events * 0.08);
  const stamp = "2026-01-01T00:00:00Z";
  // Deterministic, poorly compressible bytes make --body-bytes useful for I/O
  // rehearsals, rather than measuring PostgreSQL's compression of a repeated 'x'.
  const bytes = new Uint8Array(options.bodyBytes);
  let seed = 123456789;
  for (let i = 0; i < bytes.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  const digest = await digestContent(bytes);
  await db.transaction(async (tx) => {
    for (let start = 0; start < bodies; start += 2000) {
      const rows = [];
      for (let i = start; i < Math.min(bodies, start + 2000); i++) {
        const phase = i % 10;
        const lifecycle = phase === 0 || phase === 1;
        const value = lifecycle
          ? {
            status: phase === 0 ? "invoked" : "completed",
            actionRunId: `synthetic-run-${Math.floor(i / 10)}`,
            actionId: "synthetic.action",
            ...(phase === 0
              ? { input: { index: i } }
              : { output: { ok: true } }),
          }
          : { index: i, text: "synthetic retained event ".repeat(20) };
        const encoded = await encodeEventBody(value);
        rows.push({
          namespace: "archive",
          event_body_id: `synthetic-body-${i}`,
          schema_version: 1,
          body: JSON.parse(encoded.body),
          digest: encoded.digest,
          created_at: stamp,
        });
      }
      await tx.query(
        `INSERT INTO ${q}.event_bodies SELECT * FROM jsonb_populate_recordset(NULL::${q}.event_bodies,$1::jsonb)`,
        [JSON.stringify(rows)],
      );
      console.error(
        `[fixture:${schema}] event bodies ${
          Math.min(bodies, start + 2000)
        }/${bodies}`,
      );
    }
    await tx.query(
      `INSERT INTO ${q}.events(id,schema_version,type,namespace,payload,metadata,correlation_id,created_at)
       SELECT 'synthetic-event-'||i,7,
         CASE WHEN i%10=2 THEN 'copilotz.server.action.requested' ELSE 'synthetic.history' END,
         'archive',CASE WHEN i<$2 THEN jsonb_build_object('dataRef',jsonb_build_object('eventBodyId','synthetic-body-'||i,'schemaVersion',1,'mediaType','application/json')) ELSE '{}'::jsonb END,
         jsonb_build_object('sourceEventId','synthetic-event-'||(i-i%10+2)),'synthetic-correlation-'||i,$3::timestamptz
       FROM generate_series(0,$1::integer-1) i`,
      [options.events, bodies, stamp],
    );
    await tx.query(
      `INSERT INTO ${q}.event_deliveries(id,event_id,consumer_id,settlement_scope_id,status,attempts,created_at,updated_at,settled_at)
       SELECT 'synthetic-delivery-'||i,'synthetic-event-'||i,'synthetic.consumer','synthetic-event-'||i,'succeeded',1,$2::timestamptz,$2::timestamptz,$2::timestamptz
       FROM generate_series(0,$1::integer-1) i`,
      [Math.ceil(options.events / 5), stamp],
    );
    await tx.query(
      `INSERT INTO ${q}.nodes(id,namespace,type,name,data,created_at,updated_at)
       SELECT 'synthetic-document-'||i,'archive','synthetic_document','document-'||i,
         jsonb_build_object('assetId','synthetic-asset-'||i),$2::timestamptz,$2::timestamptz
       FROM generate_series(0,$1::integer-1) i`,
      [assets, stamp],
    );
    await tx.query(
      `INSERT INTO ${q}.nodes(id,namespace,type,name,data,created_at,updated_at)
       SELECT 'synthetic-asset-'||i,'archive','asset','asset-'||i,
         jsonb_build_object('state','ready','byteLength',$2::integer,'digest',$3::text,
           'location',jsonb_build_object('kind','database','backendId','database:default','key','synthetic-physical-'||i),
           'origin',jsonb_build_object('id','synthetic-document-'||i,'type','synthetic_document')),
         $4::timestamptz,$4::timestamptz FROM generate_series(0,$1::integer-1) i`,
      [assets, bytes.length, digest, stamp],
    );
    await tx.query(
      `INSERT INTO ${q}.nodes(id,namespace,type,name,data,created_at,updated_at)
       SELECT 'synthetic-owner-'||i,'archive','@copilotz/action-content','owner-'||i,
         jsonb_build_object('assetIds',jsonb_build_array('synthetic-asset-'||i)),
         $2::timestamptz,$2::timestamptz FROM generate_series(0,$1::integer-1) i`,
      [assets, stamp],
    );
    await tx.query(
      `INSERT INTO ${q}.edges(id,namespace,source_node_id,target_node_id,type,data,created_at)
       SELECT 'synthetic-edge-'||i,'archive','synthetic-owner-'||i,'synthetic-asset-'||i,'has_asset','{}',$2::timestamptz
       FROM generate_series(0,$1::integer-1) i`,
      [assets, stamp],
    );
    await tx.query(
      `INSERT INTO ${q}.content_bodies(body_id,state,media_type,byte_length,digest,maintenance_version,created_at,updated_at,ready_at)
       SELECT 'synthetic-physical-'||i,'ready','application/octet-stream',$2,$3,1,$4::timestamptz,$4::timestamptz,$4::timestamptz
       FROM generate_series(0,$1::integer-1) i`,
      [assets, bytes.length, digest, stamp],
    );
    await tx.query(
      `INSERT INTO ${q}.content_body_parts(body_id,start_offset,append_id,bytes,created_at)
       SELECT 'synthetic-physical-'||i,0,'synthetic-put',$2::bytea,$3::timestamptz
       FROM generate_series(0,$1::integer-1) i`,
      [assets, bytes, stamp],
    );
    // Legacy sessions were domain records. Native authorization sessions are
    // additionally seeded at v13 by the benchmark before testing v14 retention.
    await tx.query(
      `INSERT INTO ${q}.nodes(id,namespace,type,name,data,created_at,updated_at)
       SELECT 'synthetic-session-'||i,'archive','synthetic_session','session-'||i,
         jsonb_build_object('principal','synthetic-principal-'||i,'expiresAt','2030-01-01T00:00:00Z'),
         $2::timestamptz,$2::timestamptz FROM generate_series(0,$1::integer-1) i`,
      [Math.ceil(options.events / 100), stamp],
    );
    if (options.orphan) {
      const body = await encodeEventBody({
        status: "invoked",
        actionRunId: "synthetic-orphan",
        actionId: "synthetic.action",
        input: {},
      });
      await tx.query(
        `INSERT INTO ${q}.event_bodies(namespace,event_body_id,schema_version,body,digest) VALUES('archive','synthetic-orphan',1,$1::jsonb,$2)`,
        [body.body, body.digest],
      );
    }
  });
  // Use fresh statistics for both implementations; tiny seed statistics would
  // otherwise obscure the shape of the migration plans.
  for (const table of Object.keys(original.rows)) {
    await db.query(`ANALYZE ${q}."${table}"`);
  }
  return {
    events: options.events + original.rows.events.length,
    eventBodies: bodies + original.rows.event_bodies.length,
    assets: assets + 1,
    physicalBytes: assets * bytes.length,
  };
}
