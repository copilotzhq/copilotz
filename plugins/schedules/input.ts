import type { CopilotzInputEnvelope } from "@copilotz/copilotz/application";
import type {
  ScheduledJobRunNowInput,
  ScheduledJobTickInput,
} from "./types.ts";

export const SCHEDULED_JOBS_TICK_INPUT_EVENT = "copilotz.schedules.tick.input";
export const SCHEDULED_JOB_RUN_NOW_INPUT_EVENT =
  "copilotz.schedules.run-now.input";

type InputIdentity = Readonly<{
  namespace?: string;
  correlationId?: string;
  causationId?: string;
  deduplicationId?: string;
}>;

export type ScheduledJobsTickRequest = ScheduledJobTickInput & InputIdentity;
export type ScheduledJobRunNowRequest = ScheduledJobRunNowInput & InputIdentity;

export type ScheduledJobsTickInputEnvelope = CopilotzInputEnvelope<
  typeof SCHEDULED_JOBS_TICK_INPUT_EVENT,
  ScheduledJobTickInput
>;

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
  return Object.freeze({
    type,
    payload: Object.freeze(payload) as TPayload,
    ...(namespace ? { namespace } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(causationId ? { causationId } : {}),
    ...(deduplicationId ? { deduplicationId } : {}),
  });
}

/** Typed clock input. Runtime treats the result as an opaque envelope. */
export function scheduleTick(
  input: ScheduledJobsTickRequest = {},
): ScheduledJobsTickInputEnvelope {
  return envelope(SCHEDULED_JOBS_TICK_INPUT_EVENT, input);
}

/** Typed manual-run input. Runtime treats the result as an opaque envelope. */
export function runScheduledJobNow(
  input: ScheduledJobRunNowRequest,
): ScheduledJobRunNowInputEnvelope {
  return envelope(SCHEDULED_JOB_RUN_NOW_INPUT_EVENT, input);
}
