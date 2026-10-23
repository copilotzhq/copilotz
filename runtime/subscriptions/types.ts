import type {
  CollectionQuery,
  CollectionRecord,
} from "../collections/types.ts";
import type { AuthenticatedAuthority } from "../authorization/authority.ts";

export type SubscriptionDelta = Readonly<{
  seq: string;
  id: string;
  record: CollectionRecord | null;
}>;
export type SubscriptionFrame =
  | Readonly<
    {
      t: "snapshot";
      checkpoint: string;
      rows: readonly CollectionRecord[];
      sequence: string;
      complete: true;
    }
  >
  | Readonly<
    {
      t: "batch";
      checkpoint: string;
      from: string;
      to: string;
      changes: readonly SubscriptionDelta[];
      /** Exact selected window order for a non-ID ordered query. */
      order?: readonly string[];
      /** A mutation of this Collection, including outside the selected window. */
      collectionChanged?: boolean;
    }
  >
  | Readonly<{ t: "reset"; reason: string }>
  | Readonly<{ t: "revoked"; reason: string }>;
export type SubscriptionOptions = Readonly<
  {
    /** Authorize and follow Collection progress without selecting or disclosing rows. */
    progressOnly?: boolean;
    checkpoint?: string;
    signal?: AbortSignal;
    content?: import("../collections/read-options.ts").CollectionContentOptions;
  }
>;
export type CollectionSubscription = Readonly<{
  frames: AsyncIterable<SubscriptionFrame>;
  /** Acknowledge only after the consumer has atomically applied the output. */
  applied?(checkpoint: string): void;
  /** False once a transport generation has been fenced, including in-flight handlers. */
  isActive?(): boolean;
  /** Owner publication gate; may pause while a permission notice is evaluated. */
  canPublish?(): boolean;
  detach(): void;
}>;
export type CollectionObserver = (
  authority: AuthenticatedAuthority,
  collection: string,
  query?: CollectionQuery,
  options?: SubscriptionOptions,
) => Promise<CollectionSubscription>;
