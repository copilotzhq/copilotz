/** Constraint data shared by Server ingress and owner command consumers. */
import type { ActionInvocationMetadata } from "../actions/types.ts";
import type { CollectionFilter } from "../collections/types.ts";

/** Trusted policy applied to one durable collection mutation. */
export type ServerCollectionMutationPolicy = Readonly<{
  /** Fields accepted from the caller. `id` is implicit for member writes. */
  fields?: readonly string[];
  /** Exact values enforced on the mutation input. */
  input?: Readonly<Record<string, unknown>>;
  /** Existing-record scope. This is also checked against the resulting record. */
  filter?: CollectionFilter;
}>;

/** Mutation policy is deliberately separate from read collection filters. */
export type ServerCollectionMutationConstraints = Readonly<{
  create?: ServerCollectionMutationPolicy;
  update?: ServerCollectionMutationPolicy;
  delete?: ServerCollectionMutationPolicy;
  commands?: Readonly<Record<string, ServerCollectionMutationPolicy>>;
}>;

export type ServerConstraints = Readonly<{
  /** Authenticated root event types, including adapter-validated channel input. */
  events?: readonly string[];
  /** Opaque catalog selection keys chosen by owner policy for admitted work. */
  observationKeys?: readonly string[];
  assets?: Readonly<{ read?: readonly string[] }>;
  sessions?: Readonly<{ create?: boolean; revoke?: "self" | "tenant" }>;
  actions?: Readonly<
    Record<string, Readonly<{ input?: Readonly<Record<string, unknown>> }>>
  >;
  /** Host-selected conversation group for bounded HTTP admission. */
  admission?: Readonly<{ key: string }>;
  actionMetadata?: ActionInvocationMetadata;
  collections?: Readonly<
    Record<string, CollectionFilter>
  >;
  /** Explicit write policy; read filters never authorize mutations. */
  collectionMutations?: Readonly<
    Record<string, ServerCollectionMutationConstraints>
  >;
  operations?: Readonly<{
    metadata: Readonly<Record<string, unknown>>;
    /** Required missing own keys. Null and omitted requirements are not absence. */
    absentMetadata?: readonly string[];
  }>;
}>;
