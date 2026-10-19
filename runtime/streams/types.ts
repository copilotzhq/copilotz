import type { ContentCatalog, ContentCopy } from "../content/catalog.ts";
import type { ProgressiveBodyFollower } from "../content/progressive.ts";
import type {
  BodyStore,
  IncompleteBodyHead,
  ReadyBodyHead,
} from "../content/body-store.ts";
import type {
  AssetOrigin,
  ContentKind,
  ContentRole,
  PendingContentDescriptor,
  PendingContentRef,
} from "../content/types.ts";
import type { CopilotzEvent, ResolvedCopilotzEvent } from "../events/index.ts";

/** Serializable stream publication carried between runtime execution contexts. */
export type StreamOutputDescriptor = Readonly<{
  type: "stream.output";
  namespace: string;
  streamId: string;
  /** Compact durable cursor key; transports omit it from public frames. */
  replayKey?: string;
  /** Operation-local committed ordering used only by replay high-watermarks. */
  streamOrdinal?: string;
  mediaType: string;
  kind: ContentKind;
  role: ContentRole;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  causationId?: string;
  correlationId?: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

/** Transport-facing output with a per-subscriber progressive Body follower. */
export type StreamOutput =
  & StreamOutputDescriptor
  & Readonly<{
    payload: ReadableStream<Uint8Array>;
    /**
     * Catalog settlement for a durably published lane. The byte stream remains
     * a Body concern; this promise carries only generic runtime termination.
     */
    terminal: Promise<StreamTerminalStatus>;
  }>;

export type StreamTerminalOutcome =
  | "completed"
  | "failed"
  | "cancelled";

export type StreamTerminalAvailability = "retained" | "purged";

/** Generic immutable terminal boundary for one progressive stream lane. */
export type StreamTerminalStatus = Readonly<{
  outcome: StreamTerminalOutcome;
  availability: StreamTerminalAvailability;
  /** Why bytes are unavailable; never changes the logical outcome or reason. */
  availabilityReason?: string;
  /** Cause of the logical outcome, independent of byte availability. */
  reason?: string;
  offset: number;
  terminalAt: string;
}>;

/** Transport-facing in-band boundary used for non-completed stream outcomes. */
export type StreamErrorOutput =
  & StreamTerminalStatus
  & Readonly<{
    type: "stream.error";
    streamId: string;
    code: "stream_failed" | "stream_cancelled" | "stream_unavailable";
  }>;

export type RuntimeOutputDescriptor = CopilotzEvent | StreamOutputDescriptor;
/** Application-facing event outputs retain their immutable envelope and add data. */
export type ApplicationOutputDescriptor =
  | ResolvedCopilotzEvent
  | StreamOutputDescriptor;
/** Synthetic attachment boundary; it is operational metadata, not a Core Event. */
export type OperationLifecycleOutput =
  & ResolvedCopilotzEvent<
    Readonly<{ status: "completed" | "failed" | "cancelled" }>
  >
  & Readonly<{
    durable: false;
    type: `operation.${"completed" | "failed" | "cancelled"}`;
    operationId: string;
    state: "completed" | "failed" | "cancelled";
  }>;
export type ApplicationOutput = ResolvedCopilotzEvent | StreamOutput;

export type ContentStreamOpenInput = Readonly<{
  id?: string;
  mediaType: string;
  kind?: ContentKind;
  role: ContentRole;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata?: Readonly<Record<string, unknown>>;
  correlationId?: string;
}>;

export type ContentStreamOpened = Readonly<{
  id: string;
  /** Stable caller-provided identity shared by execution incarnations. */
  semanticId: string;
  /** Internal execution identity that prevents retry byte splicing. */
  incarnationId?: string;
  mediaType: string;
  kind: ContentKind;
  role: string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata: Readonly<Record<string, unknown>>;
  correlationId?: string;
}>;

export type ContentStreamAppendInput = Readonly<{
  bytes: Uint8Array;
  appendId: string;
}>;

export type ContentStreamAppendResult = Readonly<{
  startOffset: number;
  endOffset: number;
}>;

export type ContentStreamCloseInput = Readonly<{
  descriptor?: PendingContentDescriptor;
  assetId: string;
  origin?: AssetOrigin;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ContentStreamAbortInput = Readonly<{
  reason?: string;
  /** Runtime-neutral terminal outcome; omission means an ordinary failure. */
  outcome?: Exclude<StreamTerminalOutcome, "completed">;
}>;
export type ContentStreamRetentionInput =
  | Readonly<{
    retention: "canonical";
    assetId: string;
  }>
  | Readonly<{
    retention: "observation";
  }>;
export type ContentStreamFollowInput = Readonly<
  { id: string; offset?: number }
>;

export type ContentStreamWriter = Readonly<
  & AsyncDisposable
  & {
    readonly id: string;
    offset(): number;
    append(
      input: ContentStreamAppendInput,
      options?: { signal?: AbortSignal },
    ): Promise<ContentStreamAppendResult>;
    close(
      input: ContentStreamCloseInput,
      options?: { signal?: AbortSignal },
    ): Promise<PendingContentRef>;
    abort(
      input?: ContentStreamAbortInput,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
    /** Selects canonical Asset ownership or temporary reconnect retention. */
    retain(
      input: ContentStreamRetentionInput,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  }
>;

export type ContentStreamRuntime = Readonly<{
  open(
    input: ContentStreamOpenInput,
    options?: { signal?: AbortSignal },
  ): Promise<ContentStreamWriter>;
  follow(
    input: ContentStreamFollowInput,
    options?: { signal?: AbortSignal },
  ): Promise<ProgressiveBodyFollower>;
}>;

export type CreateContentStreamRuntimeOptions = Readonly<{
  namespace: string;
  store: BodyStore;
  catalog: ContentCatalog;
  producerId?: string;
  checkpointIntervalMs?: number;
  protectionMs?: number;
  storeForCopy?: (copy: ContentCopy) => BodyStore;
  /** Internal storage-root prefix. */
  bodyPrefix?: string;
  /** Makes every physical lane unique to one execution/recovery attempt. */
  incarnationId?: string;
  /** Execution lifetime; cancellation freezes any writer the caller leaked. */
  signal?: AbortSignal;
  createId?: () => string;
  onOpen?(
    input: ContentStreamOpened,
    publication: Readonly<{
      /** Marks that reconnect/live observers can discover this descriptor. */
      established(): void;
    }>,
  ): void | Promise<void>;
  onAppend?(
    stream: ContentStreamOpened,
    result: ContentStreamAppendResult,
  ): void | Promise<void>;
  /** Persists terminal intent before the physical writer is fenced. */
  onTerminalizing?(
    stream: ContentStreamOpened,
    input: Readonly<{
      outcome: StreamTerminalOutcome;
      /** Cause of the logical outcome, independent of byte availability. */
      reason?: string;
    }>,
  ): void | Promise<void>;
  onSeal?(
    stream: ContentStreamOpened,
    body: ReadyBodyHead,
  ): void | Promise<void>;
  /** Records a retained, immutable, non-adoptable committed prefix. */
  onTerminate?(
    stream: ContentStreamOpened,
    body: IncompleteBodyHead,
    input: Readonly<{
      outcome: Exclude<StreamTerminalOutcome, "completed">;
      /** Cause of the logical outcome, independent of byte availability. */
      reason?: string;
    }>,
  ): void | Promise<void>;
  /** Cleans catalog staging only when descriptor publication never succeeded. */
  onDiscard?(stream: ContentStreamOpened): void | Promise<void>;
  onRetain?(
    stream: ContentStreamOpened,
    input: ContentStreamRetentionInput,
  ): void | Promise<void>;
}>;
