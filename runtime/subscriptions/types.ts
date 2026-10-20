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
    }
  >
  | Readonly<{ t: "reset"; reason: string }>
  | Readonly<{ t: "revoked"; reason: string }>;
export type SubscriptionOptions = Readonly<
  { checkpoint?: string; signal?: AbortSignal }
>;
export type CollectionSubscription = Readonly<{
  frames: AsyncIterable<SubscriptionFrame>;
  detach(): void;
}>;
export type CollectionObserver = (
  authority: AuthenticatedAuthority,
  collection: string,
  query?: CollectionQuery,
  options?: SubscriptionOptions,
) => Promise<CollectionSubscription>;
