/** Generic internal Event-body protection used before semantic bridges. @module */

import type {
  CopilotzEvent,
  EventMutationContext,
  EventStore,
} from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type { ActionSchema } from "./types.ts";
import {
  rehydrateSecretActionValue,
  splitSecretActionValue,
} from "./secret.ts";
import {
  type PreparedProtectedValue,
  type ProtectedValueRef,
  protectedValueRef,
  type ProtectedValueRuntime,
} from "./protected-value.ts";
import { durableActionValue, sameActionValue } from "./value.ts";

export const PROTECTED_EVENT_BODY_SCHEMA =
  "copilotz.event.protected-value.v1" as const;

export type ProtectedEventBody = Readonly<{
  schema: typeof PROTECTED_EVENT_BODY_SCHEMA;
  ownerId: string;
  data: unknown;
  protected: ProtectedValueRef;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

export function protectedEventBody(value: unknown): ProtectedEventBody | null {
  const input = record(value);
  if (input.schema !== PROTECTED_EVENT_BODY_SCHEMA) return null;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 4 ||
    keys.some((key) =>
      key !== "schema" && key !== "ownerId" && key !== "data" &&
      key !== "protected"
    )
  ) throw new TypeError("Protected Event body is invalid.");
  return Object.freeze({
    schema: PROTECTED_EVENT_BODY_SCHEMA,
    ownerId: requiredText(input.ownerId, "Protected Event owner id"),
    data: durableActionValue(input.data),
    protected: protectedValueRef(input.protected),
  });
}

export function publicProtectedEventData(value: unknown): unknown {
  return protectedEventBody(value)?.data ?? value;
}

export function protectedEventRefs(
  value: unknown,
): readonly ProtectedValueRef[] {
  const body = protectedEventBody(value);
  return body ? Object.freeze([body.protected]) : Object.freeze([]);
}

export async function prepareProtectedEventBody(
  input: Readonly<{
    namespace: string;
    ownerId: string;
    data: unknown;
    schema: ActionSchema;
    protectedValues?: ProtectedValueRuntime;
  }>,
): Promise<
  Readonly<{
    body: unknown;
    publicData: unknown;
    prepared: readonly PreparedProtectedValue[];
  }>
> {
  const split = splitSecretActionValue(input.schema, input.data);
  if (!split.secret) {
    return Object.freeze({
      body: split.publicValue,
      publicData: split.publicValue,
      prepared: Object.freeze([]),
    });
  }
  if (!input.protectedValues) {
    throw new Error("Protected Event ingress requires a Secret Adapter.");
  }
  const ownerId = requiredText(input.ownerId, "Protected Event owner id");
  const prepared = await input.protectedValues.prepare({
    namespace: input.namespace,
    ownerId,
    slot: "data",
  }, input.data);
  return Object.freeze({
    body: Object.freeze({
      schema: PROTECTED_EVENT_BODY_SCHEMA,
      ownerId,
      data: split.publicValue,
      protected: prepared.ref,
    }),
    publicData: split.publicValue,
    prepared: Object.freeze([prepared]),
  });
}

export async function hydrateProtectedEventBody(
  input: Readonly<{
    namespace: string;
    body: unknown;
    schema: ActionSchema;
    protectedValues: ProtectedValueRuntime;
  }>,
): Promise<unknown> {
  const body = protectedEventBody(input.body);
  if (!body) return durableActionValue(input.body);
  const plaintext = await input.protectedValues.open({
    namespace: input.namespace,
    ownerId: body.ownerId,
    slot: "data",
  }, body.protected);
  return rehydrateSecretActionValue(input.schema, body.data, plaintext);
}

/** Trusted bridge hydration after the schema projection was enforced at write. */
export async function openProtectedEventBody(
  input: Readonly<{
    namespace: string;
    body: unknown;
    protectedValues?: ProtectedValueRuntime;
  }>,
): Promise<unknown> {
  const body = protectedEventBody(input.body);
  if (!body) return durableActionValue(input.body);
  if (!input.protectedValues) {
    throw new Error("Protected Event recovery requires a Secret Adapter.");
  }
  return await input.protectedValues.open({
    namespace: input.namespace,
    ownerId: body.ownerId,
    slot: "data",
  }, body.protected);
}

export function samePreparedProtectedEventBody(
  leftValue: unknown,
  rightValue: unknown,
): boolean {
  const left = protectedEventBody(leftValue);
  const right = protectedEventBody(rightValue);
  if (!left || !right) return sameActionValue(leftValue, rightValue);
  return left.ownerId === right.ownerId &&
    sameActionValue(left.data, right.data) &&
    left.protected.commitment === right.protected.commitment;
}

export async function resolveProtectedEventData(
  input: Readonly<{
    store: Pick<EventStore, "session" | "tables">;
    event: CopilotzEvent;
    schema: ActionSchema;
    protectedValues: ProtectedValueRuntime;
  }>,
): Promise<unknown> {
  if (!input.event.durable) return input.event.payload;
  const body = await readEventBody(
    { transaction: input.store.session, tables: input.store.tables },
    input.event.namespace,
    eventDataRef(input.event.payload),
  );
  return await hydrateProtectedEventBody({
    namespace: input.event.namespace,
    body,
    schema: input.schema,
    protectedValues: input.protectedValues,
  });
}

export async function projectProtectedEventOwners(
  context: EventMutationContext,
  namespace: string,
  body: unknown,
  protectedValues: ProtectedValueRuntime,
): Promise<void> {
  for (const ref of protectedEventRefs(body)) {
    await protectedValues.project(context, namespace, ref);
  }
}
