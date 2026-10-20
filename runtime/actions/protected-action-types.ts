/** Owner-created admission classification; it does not authorize an end user. */
export type ProtectedActionIngress =
  & Readonly<
    {
      authority?:
        import("../authorization/authority.ts").AuthenticatedAuthority;
    }
  >
  & Readonly<
    { kind: "host" } | { kind: "server-route"; routeId: string } | {
      kind: "scheduled-occurrence";
      scheduleId: string;
      occurrenceId: string;
      scheduledFor: string;
      scheduleVersion: string;
    } | {
      kind: "authenticated-server";
      actor: Readonly<
        { id: string; externalId?: string; name?: string; email?: string }
      >;
    }
  >;
/** Retained owner-resolved invocation, never caller-selected metadata. */
export type ProtectedActionSourceEntry = Readonly<{
  event: Readonly<{
    id: string;
    type: string;
    namespace: string;
    metadata: Readonly<Record<string, unknown>>;
  }>;
  data: unknown;
  /** Present only when exact retained event/body has owner-created admission evidence. */
  ingress?: ProtectedActionIngress;
}>;
export type ProtectedActionSource =
  & ProtectedActionSourceEntry
  & Readonly<{
    /** Root-first retained operation ingress chain, including the original root. */
    ancestors: readonly ProtectedActionSourceEntry[];
  }>;
