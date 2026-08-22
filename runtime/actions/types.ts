import type {
  CoordinatedMutationResult,
  DurableEvent,
  DurableEventDraft,
} from "../events/index.ts";

export type ActionStatus =
  | "invoked"
  | "completed"
  | "failed"
  | "cancelled";

export type SerializedActionError = Readonly<{
  name: string;
  message: string;
  stack?: string;
}>;

type ActionEventBase<I> = Readonly<{
  actionRunId: string;
  actionId: string;
  parentActionRunId?: string;
  input: I;
}>;

export type ActionInvokedData<I = unknown> =
  & ActionEventBase<I>
  & Readonly<{ status: "invoked" }>;

export type ActionCompletedData<I = unknown, O = unknown> =
  & ActionEventBase<I>
  & Readonly<{
    status: "completed";
    output: O;
  }>;

export type ActionFailedData<I = unknown> =
  & ActionEventBase<I>
  & Readonly<{
    status: "failed" | "cancelled";
    error: SerializedActionError;
  }>;

export type ActionEventData<I = unknown, O = unknown> =
  | ActionInvokedData<I>
  | ActionCompletedData<I, O>
  | ActionFailedData<I>;

type ActionLifecycleEnvelope = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId: string;
  settlementScopeId?: string;
}>;

export type ActionLifecycleInput<I = unknown, O = unknown> =
  & ActionEventData<I, O>
  & ActionLifecycleEnvelope;

export type ActionLifecycleAppendInput = Readonly<{
  draft: Omit<DurableEventDraft, "payload">;
  data: ActionEventData;
}>;

export type ActionLifecycleEmitter = Readonly<{
  emit<I = unknown, O = unknown>(
    input: ActionLifecycleInput<I, O>,
  ): Promise<CoordinatedMutationResult<void> | DurableEvent>;
  terminal(
    actionRunId: string,
  ): Promise<ActionCompletedData | ActionFailedData | null>;
}>;

export type ActionLifecycleAppender = (
  input: ActionLifecycleAppendInput,
) => Promise<CoordinatedMutationResult<void>>;

export type ActionLifecycleLoader = (
  namespace: string,
  deduplicationId: string,
) => Promise<ActionEventData | null>;
