/** Reviewed exceptions to retained invocation/terminal pairing. No invented bodies. */
import { digestContent } from "../content/digest.ts";
import { verifiedEventBody } from "../events/body-store.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  assertRetainedDataDrained,
  inspectRetainedDataDrain,
} from "./drain.ts";

export type AbandonedRun = Readonly<{
  namespace: string;
  runId: string;
  actionId: string;
  bodyId: string;
}>;
export type AbandonmentDecisions = Readonly<{
  entries: readonly AbandonedRun[];
  digest: string;
}>;
export type RetainedTerminal =
  & AbandonedRun
  & Readonly<{
    bodyDigest: string;
    status: "completed" | "failed" | "cancelled";
    terminalSource: "wrapper-attested" | "reviewed-abandonment";
    wrapperRunId?: string;
    wrapperBodyId?: string;
    wrapperBodyDigest?: string;
    reason?: "abandoned-before-upgrade";
  }>;
export type RetainedTerminals = Readonly<{
  attested: number;
  abandoned: number;
  runs: readonly RetainedTerminal[];
}>;

/** Canonical, digest-bound exact identities, also usable by listing consumers. */
export async function abandonmentDecisions(
  entries: readonly AbandonedRun[],
): Promise<AbandonmentDecisions> {
  if (!Array.isArray(entries)) {
    throw new TypeError("Abandoned entries must be an array.");
  }
  const seen = new Set<string>();
  const canonical = entries.map((entry) => {
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !==
        "actionId,bodyId,namespace,runId" ||
      Object.values(entry).some((value) =>
        typeof value !== "string" || !value.trim()
      )
    ) {
      throw new TypeError(
        "Abandoned entries require exact namespace, runId, actionId, bodyId strings.",
      );
    }
    const key = JSON.stringify([entry.namespace, entry.runId]);
    if (seen.has(key)) {
      throw new Error(`Duplicate abandonment decision: ${entry.runId}.`);
    }
    seen.add(key);
    return {
      namespace: entry.namespace,
      runId: entry.runId,
      actionId: entry.actionId,
      bodyId: entry.bodyId,
    };
  }).sort((a, b) =>
    JSON.stringify(a) < JSON.stringify(b)
      ? -1
      : JSON.stringify(a) > JSON.stringify(b)
      ? 1
      : 0
  );
  return {
    entries: canonical,
    digest: await digestContent(
      new TextEncoder().encode(JSON.stringify(canonical)),
    ),
  };
}
export async function verifyAbandonmentDecisions(
  value?: AbandonmentDecisions,
): Promise<AbandonmentDecisions | undefined> {
  if (value === undefined) return undefined;
  const canonical = await abandonmentDecisions(value.entries);
  if (value.digest !== canonical.digest) {
    throw new Error("Abandonment decisions digest changed.");
  }
  return canonical;
}

type Body = {
  namespace: string;
  event_body_id: string;
  body: Record<string, unknown>;
  digest: string;
  schema_version: number;
};
const terminals = new Set(["completed", "failed", "cancelled"]);
async function verify(body: Body) {
  await verifiedEventBody(body, {
    eventBodyId: body.event_body_id,
    schemaVersion: body.schema_version,
    mediaType: "application/json",
  });
}

/** Read only; invalid evidence remains visible to listing and fails validation. */
export async function inspectUnterminatedRuns(tx: SqlExecutor, schema: string) {
  const result = [];
  for await (const entry of iterateUnterminatedRuns(tx, schema)) {
    // Listing needs identities and evidence summaries, never retained payloads.
    const { body: _body, ...summary } = entry;
    result.push(summary);
  }
  return result;
}
async function* iterateUnterminatedRuns(tx: SqlExecutor, schema: string) {
  const table = createCoreTableNames(schema).event_bodies;
  const summaries = (await tx.query<{
    namespace: string;
    event_body_id: string;
    run_id: string;
    action_id: string | null;
    body_count: number;
    invoked_count: number;
    conflicting: boolean;
    wrapper_ids: string[] | null;
  }>(
    // Extract every key once and hash-join; a per-run JSON predicate over
    // event_bodies has no index and rescans the whole table for each run.
    `WITH keys AS MATERIALIZED (
         SELECT namespace,event_body_id,body->>'status' AS status,
                body->>'actionRunId' AS run_id,body->>'actionId' AS action_id,
                body->'output'->>'targetActionRunId' AS target_run
         FROM ${table}
       ),
       incomplete AS (
         SELECT namespace,run_id,action_id FROM keys
         WHERE run_id IS NOT NULL AND status IN ('invoked','completed','failed','cancelled')
         GROUP BY namespace,run_id,action_id
         HAVING bool_or(status='invoked') AND
           (action_id IS NULL OR NOT bool_or(status IN ('completed','failed','cancelled')))
       ),
       incomplete_runs AS MATERIALIZED (
         SELECT k.namespace,k.event_body_id,k.run_id,k.action_id
         FROM keys k JOIN incomplete i ON k.namespace=i.namespace
           AND k.run_id=i.run_id AND k.action_id IS NOT DISTINCT FROM i.action_id
         WHERE k.status='invoked'
       ),
       runs AS MATERIALIZED (SELECT DISTINCT namespace,run_id FROM incomplete_runs),
       stats AS (
         SELECT i.namespace,i.run_id,i.event_body_id,
           count(*)::integer AS body_count,
           (count(*) FILTER (WHERE b.status='invoked'))::integer AS invoked_count,
           bool_or(b.action_id IS DISTINCT FROM i.action_id OR b.status IN ('completed','failed','cancelled')) AS conflicting
         FROM incomplete_runs i JOIN keys b ON b.namespace=i.namespace AND b.run_id=i.run_id
         GROUP BY i.namespace,i.run_id,i.event_body_id
       ),
       wrappers AS (
         SELECT k.namespace,k.target_run AS run_id,
           array_agg(k.event_body_id ORDER BY k.event_body_id) AS wrapper_ids
         FROM keys k JOIN runs r ON k.namespace=r.namespace AND k.target_run=r.run_id
         GROUP BY k.namespace,k.target_run
       )
       SELECT i.*,s.body_count,s.invoked_count,s.conflicting,w.wrapper_ids
       FROM incomplete_runs i
       JOIN stats s USING (namespace,run_id,event_body_id)
       LEFT JOIN wrappers w USING (namespace,run_id)
       ORDER BY i.namespace,i.run_id,i.event_body_id`,
  )).rows;
  // Retain summaries only; payloads are fetched once per bounded PK batch.
  const bodyKey = (namespace: string, id: string) =>
    JSON.stringify([namespace, id]);
  for (let start = 0; start < summaries.length; start += 1000) {
    const rows = summaries.slice(start, start + 1000);
    const keys = rows.flatMap((row) =>
      [row.event_body_id, ...(row.wrapper_ids ?? []).slice(0, 2)].map((id) => ({
        namespace: row.namespace,
        id,
      }))
    );
    const bodies = (await tx.query<Body>(
      `SELECT b.* FROM ${table} b JOIN
       (SELECT DISTINCT namespace,id FROM jsonb_to_recordset($1::jsonb) AS v(namespace text,id text)) k
       ON b.namespace=k.namespace AND b.event_body_id=k.id`,
      [JSON.stringify(keys)],
    )).rows;
    const byKey = new Map(
      bodies.map((body) => [bodyKey(body.namespace, body.event_body_id), body]),
    );
    for (const row of rows) {
      const body = byKey.get(bodyKey(row.namespace, row.event_body_id))!;
      // Same as the former LIMIT 2: two candidates are enough to refuse.
      const wrappers = (row.wrapper_ids ?? []).slice(0, 2).map((id) =>
        byKey.get(bodyKey(row.namespace, id))!
      );
      const identity = {
        namespace: row.namespace,
        runId: row.run_id,
        actionId: row.action_id,
        bodyId: row.event_body_id,
      };
      let refusal: string | undefined;
      let attestation: RetainedTerminal | undefined;
      if (wrappers.length) {
        const wrapper = wrappers[0];
        const output = wrapper.body.output as Record<string, unknown>;
        if (wrappers.length !== 1) refusal = "ambiguous attestation";
        else if (
          wrapper.body.actionId !== "copilotz.server.internal.invoke" ||
          !row.action_id ||
          (output.actionId !== undefined &&
            output.actionId !== row.action_id) ||
          (output.targetActionId !== undefined &&
            output.targetActionId !== row.action_id)
        ) refusal = "mismatched action in attestation";
        else if (
          typeof wrapper.body.status !== "string" ||
          !terminals.has(wrapper.body.status) ||
          typeof output.status !== "string" || !terminals.has(output.status)
        ) refusal = "non-terminal attestation status";
        else if (
          row.invoked_count !== 1 || row.conflicting
        ) refusal = "conflicting invocation or terminal in attestation";
        else if (
          typeof wrapper.body.actionRunId !== "string" ||
          !wrapper.body.actionRunId.trim() ||
          wrapper.body.actionRunId === row.run_id
        ) refusal = "invalid wrapper run";
        else {
          await verify(body);
          await verify(wrapper);
          attestation = {
            ...identity,
            actionId: row.action_id!,
            bodyDigest: body.digest,
            status: output.status as RetainedTerminal["status"],
            terminalSource: "wrapper-attested",
            wrapperRunId: wrapper.body.actionRunId as string,
            wrapperBodyId: wrapper.event_body_id,
            wrapperBodyDigest: wrapper.digest,
          };
        }
      }
      yield {
        ...identity,
        attestation,
        refusal,
        body,
        bodyCount: row.body_count,
      };
    }
  }
}

export async function resolveRetainedTerminals(
  tx: SqlExecutor,
  schema: string,
  decisions?: AbandonmentDecisions,
): Promise<RetainedTerminals | undefined> {
  const reviewed = await verifyAbandonmentDecisions(decisions);
  if (reviewed?.entries.length) {
    assertRetainedDataDrained(await inspectRetainedDataDrain(tx, schema));
  }
  const remaining = new Map(
    (reviewed?.entries ?? []).map(
      (e) => [JSON.stringify([e.namespace, e.runId]), e],
    ),
  );
  const runs: RetainedTerminal[] = [];
  for await (const entry of iterateUnterminatedRuns(tx, schema)) {
    if (entry.refusal) {
      throw new Error(
        `Invalid retained history: ${entry.refusal}: ${entry.bodyId}.`,
      );
    }
    const key = JSON.stringify([entry.namespace, entry.runId]);
    const decision = remaining.get(key);
    if (entry.attestation) {
      if (decision) {
        throw new Error(
          `Abandonment decision has an attested terminal: ${entry.bodyId}.`,
        );
      }
      runs.push(entry.attestation);
    } else if (
      decision && entry.bodyCount === 1 &&
      decision.actionId === entry.actionId && decision.bodyId === entry.bodyId
    ) {
      await verify(entry.body);
      remaining.delete(key);
      runs.push({
        ...decision,
        bodyDigest: entry.body.digest,
        status: "cancelled",
        terminalSource: "reviewed-abandonment",
        reason: "abandoned-before-upgrade",
      });
    } else {throw new Error(
        `Drain existing Action history before upgrading: invocation ${entry.bodyId} has no confirmed terminal. Original replay eligibility is never inferred from an empty effects table.`,
      );}
  }
  if (remaining.size) {
    throw new Error(
      "Abandonment decision has a terminal, multiple bodies, or does not match retained history.",
    );
  }
  if (!runs.length) return undefined;
  return {
    attested:
      runs.filter((r) => r.terminalSource === "wrapper-attested").length,
    abandoned:
      runs.filter((r) => r.terminalSource === "reviewed-abandonment").length,
    runs,
  };
}

export function retainedTerminalKey(namespace: string, runId: string): string {
  return JSON.stringify(["action.upgrade-terminal", namespace, runId]);
}
export async function recordRetainedTerminals(
  tx: SqlExecutor,
  schema: string,
  report: RetainedTerminals | undefined,
  fingerprint: string,
) {
  const runs = report?.runs ?? [];
  for (let start = 0; start < runs.length; start += 1000) {
    await tx.query(
      `INSERT INTO ${createCoreTableNames(schema).owner_receipts}
       (owner,domain,key,principal,kind,intent,result)
       SELECT 'schema','logical',key,'offline-upgrade','action.upgrade-terminal',$1::jsonb,result
       FROM jsonb_to_recordset($2::jsonb) AS v(key text,result jsonb)`,
      [
        JSON.stringify({ fingerprint }),
        JSON.stringify(
          runs.slice(start, start + 1000).map((run) => ({
            key: retainedTerminalKey(run.namespace, run.runId),
            result: run,
          })),
        ),
      ],
    );
  }
}

/** Shared upgrade predicate; includes every invoked body in each refused group. */
export function unterminatedInvocationsSql(schema: string): string {
  return `WITH keys AS MATERIALIZED (
       SELECT namespace,event_body_id,body->>'status' AS status,
              body->>'actionRunId' AS run_id,body->>'actionId' AS action_id
       FROM ${createCoreTableNames(schema).event_bodies}
     )
     , incomplete AS (SELECT namespace,run_id,action_id
     FROM keys
     WHERE run_id IS NOT NULL AND status IN ('invoked','completed','failed','cancelled')
     GROUP BY namespace,run_id,action_id
     HAVING bool_or(status='invoked') AND
       (action_id IS NULL OR NOT bool_or(status IN ('completed','failed','cancelled')))
     )
     SELECT k.namespace,k.event_body_id,k.run_id,k.action_id
     FROM keys k JOIN incomplete i ON k.namespace=i.namespace
       AND k.run_id=i.run_id AND k.action_id IS NOT DISTINCT FROM i.action_id
     WHERE k.status='invoked'`;
}
