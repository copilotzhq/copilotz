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
  let after: [string, string, string] | undefined;
  while (true) {
    const rows = (await tx.query<{
      namespace: string;
      event_body_id: string;
      run_id: string;
      action_id: string | null;
      body_count: number;
      invoked_count: number;
      conflicting: boolean;
    }>(
      `WITH incomplete_runs AS MATERIALIZED (${
        unterminatedInvocationsSql(schema)
      })
       SELECT i.*,s.body_count,s.invoked_count,s.conflicting FROM incomplete_runs i
       CROSS JOIN LATERAL (
         SELECT count(*)::integer AS body_count,
           count(*) FILTER (WHERE b.body->>'status'='invoked')::integer AS invoked_count,
           bool_or(b.body->>'actionId' IS DISTINCT FROM i.action_id OR b.body->>'status' IN ('completed','failed','cancelled')) AS conflicting
         FROM ${table} b WHERE b.namespace=i.namespace AND b.body->>'actionRunId'=i.run_id
       ) s
       ${after ? "WHERE (i.namespace,i.run_id,i.event_body_id)>($1,$2,$3)" : ""}
       ORDER BY i.namespace,i.run_id,i.event_body_id LIMIT 1000`,
      after ?? [],
    )).rows;
    for (const row of rows) {
      const body = (await tx.query<Body>(
        `SELECT * FROM ${table} WHERE namespace=$1 AND event_body_id=$2`,
        [row.namespace, row.event_body_id],
      )).rows[0];
      const wrappers = (await tx.query<Body>(
        `SELECT * FROM ${table} WHERE namespace=$1 AND body->'output'->>'targetActionRunId'=$2 ORDER BY event_body_id LIMIT 2`,
        [row.namespace, row.run_id],
      )).rows;
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
    if (rows.length < 1000) break;
    const last = rows.at(-1)!;
    after = [last.namespace, last.run_id, last.event_body_id];
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
  for (const run of report?.runs ?? []) {
    await tx.query(
      `INSERT INTO ${createCoreTableNames(schema).owner_receipts}
      (owner,domain,key,principal,kind,intent,result) VALUES ('schema','logical',$1,'offline-upgrade','action.upgrade-terminal',$2::jsonb,$3::jsonb)`,
      [
        retainedTerminalKey(run.namespace, run.runId),
        JSON.stringify({ fingerprint }),
        JSON.stringify(run),
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
