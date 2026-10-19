/**
 * Creates typed Schedule input envelopes for manual runs.
 *
 * @module
 */

import type { CopilotzInputEnvelope } from "@copilotz/copilotz/application";
import type { ScheduledJobRunNowInput } from "../../shared/contracts.ts";

export const SCHEDULED_JOB_RUN_NOW_INPUT_EVENT =
  "copilotz.schedules.run-now.input";

type InputIdentity = Readonly<{
  namespace?: string;
  correlationId?: string;
  causationId?: string;
  deduplicationId?: string;
}>;

export type ScheduledJobRunNowRequest = ScheduledJobRunNowInput & InputIdentity;

export type ScheduledJobRunNowInputEnvelope = CopilotzInputEnvelope<
  typeof SCHEDULED_JOB_RUN_NOW_INPUT_EVENT,
  ScheduledJobRunNowInput
>;

function envelope<TType extends string, TPayload extends object>(
  type: TType,
  input: TPayload & InputIdentity,
): CopilotzInputEnvelope<TType, TPayload> {
  const {
    namespace,
    correlationId,
    causationId,
    deduplicationId,
    ...payload
  } = input;
  return ({
    type,
    payload: payload as TPayload,
    ...(namespace ? { namespace } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(causationId ? { causationId } : {}),
    ...(deduplicationId ? { deduplicationId } : {}),
  } as const);
}

/** Typed manual-run input. Runtime treats the result as an opaque envelope. */
export function runScheduledJobNow(
  input: ScheduledJobRunNowRequest,
): ScheduledJobRunNowInputEnvelope {
  return envelope(SCHEDULED_JOB_RUN_NOW_INPUT_EVENT, input);
}
