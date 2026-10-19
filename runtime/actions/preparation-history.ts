import {
  NAMED_PREPARATION_INTEGRITY,
  NAMED_PREPARATION_MARKER as marker,
  preparationIntegrity,
} from "./preparation-proof.ts";
import { actionPreparationIntent } from "./preparation-intent.ts";
import type { ActionEventData } from "./types.ts";
/** Validate named provenance against the existing Action/Event Body inventory.
 * No permission is inferred here; every later use still runs current policy. */
import { createCoreTableNames } from "../events/schema.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { publicActionLifecycleData } from "./protected-lifecycle.ts";
import {
  ACTION_PREPARATION_SCHEMA,
  parseActionPreparationCapture,
} from "./preparation-capture.ts";
import type { CompiledActionPreparations } from "./preparation.ts";
import {
  preparationCanonical as canonical,
  preparationData,
  preparationError as fail,
  preparationText as text,
} from "./preparation-data.ts";
const kind = "actions.prepareNamed";
export async function validateNamedPreparationHistory(
  transaction: SqlExecutor,
  schema: string,
  registry: PluginRegistry,
  compiled?: CompiledActionPreparations,
): Promise<void> {
  const tables = createCoreTableNames(schema);
  const receipts = await transaction.query<
    { key: string; intent: unknown; result: unknown }
  >(
    `SELECT key,intent,result FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND kind=$1`,
    [kind],
  );
  const retained = new Map<string, string>();
  for (const receipt of receipts.rows) {
    const stored = preparationData(receipt.result) as Record<string, unknown>;
    if (
      !stored ||
      Object.keys(stored).sort().join(",") !==
        "binding,capture,eventId,identity,schema" ||
      stored.schema !== ACTION_PREPARATION_SCHEMA
    ) fail("preparation_capture_invalid");
    const binding = stored.binding as Record<string, unknown>;
    if (
      !binding || typeof binding !== "object" || Array.isArray(binding) ||
      Object.keys(binding).some((key) =>
        ![
          "namespace",
          "actionId",
          "actionRunId",
          "parentActionRunId",
          "sourceEventId",
          "operationId",
        ].includes(key)
      )
    ) fail("preparation_capture_invalid");
    for (
      const key of ["namespace", "actionId", "actionRunId", "sourceEventId"]
    ) text(binding[key]);
    for (const key of ["parentActionRunId", "operationId"]) {
      if (Object.hasOwn(binding, key)) text(binding[key]);
    }
    const identity = stored.identity as Record<string, unknown>;
    if (
      !identity ||
      Object.keys(identity).sort().join(",") !==
        "operationKey,parentOperationKey" ||
      receipt.key !==
        JSON.stringify([
          kind,
          binding.namespace,
          text(identity.parentOperationKey),
          text(identity.operationKey),
        ])
    ) fail("preparation_capture_invalid");
    const intent = receipt.intent as Record<string, unknown>;
    if (
      !intent || Object.keys(intent).sort().join(",") !== "digest,encoding" ||
      intent.encoding !== "copilotz.preparation.v1" ||
      typeof intent.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(intent.digest)
    ) fail("preparation_capture_invalid");
    const capture = parseActionPreparationCapture(stored.capture);
    const expectedIntent = await actionPreparationIntent({
      preparation: capture.preparation,
      parentOperationKey: identity.parentOperationKey as string,
      operationKey: identity.operationKey as string,
      source: capture.source.source.name,
      recordId: capture.source.source.recordId,
      actionId: binding.actionId as string,
      hints: capture.view.hints,
    });
    if (canonical(intent) !== canonical(expectedIntent)) {
      fail("preparation_capture_invalid");
    }
    const registration = compiled?.registrations.get(capture.preparation);
    if (
      !registration || !Object.values(registry.actions).some((action) =>
        action.id === binding.actionId
      ) || registration.actionId !== binding.actionId ||
      registration.source !== capture.source.source.name ||
      canonical(registration.shows) !== canonical(capture.view.shows) ||
      !registration.modes.includes(capture.view.hints.mode)
    ) {
      fail("preparation_registration_missing");
    }
    if (capture.source.source.namespace !== binding.namespace) {
      fail("preparation_capture_invalid");
    }
    const event = (await transaction.query<
      { id: string; payload: unknown; deduplication_id: string }
    >(
      `SELECT id,payload,deduplication_id FROM ${tables.events} WHERE namespace=$1 AND id=$2`,
      [binding.namespace, text(stored.eventId)],
    )).rows[0];
    const source = await transaction.query(
      `SELECT id FROM ${tables.events} WHERE id=$1 AND namespace=$2`,
      [binding.sourceEventId, binding.namespace],
    );
    if (
      !event ||
      event.deduplication_id !== `${binding.actionRunId}:action:invoked` ||
      source.rows.length !== 1
    ) {
      fail("preparation_capture_orphan");
    }
    const data = publicActionLifecycleData(
      await readEventBody(
        { transaction, tables },
        binding.namespace as string,
        eventDataRef(event.payload),
      ),
    ) as ActionEventData;
    if (
      data.status !== "invoked" || data.actionId !== binding.actionId ||
      data.actionRunId !== binding.actionRunId ||
      data.parentActionRunId !== binding.parentActionRunId ||
      data.metadata[marker] !== receipt.key
    ) {
      fail("preparation_capture_invalid");
    }
    if (
      data.metadata[NAMED_PREPARATION_INTEGRITY] !==
        await preparationIntegrity({ binding, capture, identity, intent })
    ) {
      fail("preparation_capture_invalid");
    }
    retained.set(event.id, receipt.key);
  }
  // Catch missing receipts even if callers omit the untrusted metadata cue.
  const events = await transaction.query<
    { id: string; namespace: string; payload: unknown }
  >(
    `SELECT event.id,event.namespace,event.payload FROM ${tables.events} event JOIN ${tables.event_bodies} body ON body.namespace=event.namespace AND body.event_body_id=event.payload->'dataRef'->>'eventBodyId' WHERE body.body->'metadata' ? $1 OR body.body->'data'->'metadata' ? $1`,
    [marker],
  );
  for (const event of events.rows) {
    const data = publicActionLifecycleData(
      await readEventBody(
        { transaction, tables },
        event.namespace,
        eventDataRef(event.payload),
      ),
    ) as ActionEventData;
    if (!Object.hasOwn(data.metadata, marker)) continue;
    const key = data.metadata[marker];
    if (
      typeof key !== "string" ||
      !receipts.rows.some((receipt) => receipt.key === key)
    ) fail("preparation_capture_orphan");
    if (data.status === "invoked" && retained.get(event.id) !== key) {
      fail("preparation_capture_orphan");
    }
  }
}
