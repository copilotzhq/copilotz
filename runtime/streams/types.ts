import type { ProgressiveBodyFollower } from "../content/progressive.ts";
import type { BodyStore } from "../content/body-store.ts";
import type {
  AssetOrigin,
  ContentKind,
  ContentRole,
  PreparedContent,
} from "../content/types.ts";
import type { CopilotzEvent, ResolvedCopilotzEvent } from "../events/index.ts";

/** Serializable stream publication carried between runtime execution contexts. */
export type StreamOutputDescriptor = Readonly<{
  type: "stream.output";
  namespace: string;
  streamId: string;
  mediaType: string;
  kind: ContentKind;
  role: ContentRole | string;
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
  }>;

export type RuntimeOutputDescriptor = CopilotzEvent | StreamOutputDescriptor;
/** Application-facing event outputs retain their immutable envelope and add data. */
export type ApplicationOutputDescriptor =
  | ResolvedCopilotzEvent
  | StreamOutputDescriptor;
export type ApplicationOutput = ResolvedCopilotzEvent | StreamOutput;

export type ContentStreamOpenInput = Readonly<{
  id?: string;
  mediaType: string;
  kind?: ContentKind;
  role: ContentRole | string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata?: Readonly<Record<string, unknown>>;
  correlationId?: string;
}>;

export type ContentStreamOpened = Readonly<{
  id: string;
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
  assetId: string;
  origin?: AssetOrigin;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ContentStreamAbortInput = Readonly<{ reason?: string }>;
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
    ): Promise<PreparedContent>;
    abort(
      input?: ContentStreamAbortInput,
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
  createId?: () => string;
  onOpen?(input: ContentStreamOpened): void | Promise<void>;
}>;
