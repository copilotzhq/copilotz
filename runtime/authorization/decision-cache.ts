/** Reuse collection reads and their disclosures; mutation outcomes remain fresh. */
import type {
  AuthenticatedAuthority,
  AuthorityDependency,
} from "./authority.ts";
import type {
  AuthorizationDecision,
  AuthorizationIntent,
  OwnerPolicy,
} from "./evaluator.ts";
import { stableStringify } from "../collections/equal.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  authorizationDependencyKeys,
  authorizationTableKey,
  cachedAuthorization,
  rememberAuthorization,
} from "./cache.ts";
import { type PolicyReadSet, policyReadValues } from "./policy-reads.ts";
import { ownerAttemptLive } from "./leases.ts";

const readMethods = new Set([
  "get",
  "list",
  "aggregate",
  "search",
  "query",
  "relations.list",
  "vectors.search",
]);

type Signatures = {
  paths: readonly PolicyReadSet[];
  sessionExpiresAt?: string;
};
type Entry = {
  decision: AuthorizationDecision;
  policy: OwnerPolicy;
  revision: string;
  until: number;
  lifetime: { valid: boolean };
};
export function createDecisionReuse(schema: string) {
  const scope = { cache: "evaluation" };
  const signatures = { cache: "evaluation-signatures" };
  return {
    key(
      authority: AuthenticatedAuthority,
      intent: AuthorizationIntent,
    ): string | undefined {
      const phase = (intent.input as { phase?: unknown } | null)?.phase;
      if (
        !(intent.kind === "collection" && readMethods.has(intent.operation) &&
            (phase === "read" || phase === "result") ||
          intent.kind === "observation" && intent.operation === "attach")
      ) return;
      // These are execution fences, independently of what policy code reads.
      // Session identity and namespace cannot inherit another principal's grant.
      const { owner, databaseSchema, namespace, tenant } = authority.scope;
      return stableStringify([
        { owner, databaseSchema, namespace, tenant },
        authority.principal,
        authority.authorityBasis.kind === "attempt"
          ? { kind: "attempt" }
          : authority.authorityBasis,
        authority.validity.kind === "occurrence" ? authority.validity : null,
        authority.policy,
        authority.dependencies,
        intent.kind,
        intent.resource,
        intent.operation,
        phase ?? null,
        this.dependencies(authority, intent),
        // A disclosure is always bound to the actual result/current version.
        phase === "result"
          ? [
            (intent.input as { current?: unknown }).current ?? null,
            (intent.input as { result?: unknown }).result ?? null,
          ]
          : null,
        // Flow completion has additional implicit invocation rules.
        authority.flow ? [authority, intent] : null,
      ]);
    },
    dependencies(
      authority: AuthenticatedAuthority,
      intent: AuthorizationIntent,
    ): AuthorityDependency[] {
      if (intent.kind !== "collection") return [];
      const input = intent.input as {
        collection?: { name?: string };
        method?: string;
        args?: { id?: unknown };
        current?: { id?: unknown } | null;
      };
      const name = input.collection?.name;
      if (!name) return [];
      const id = input.current?.id ?? input.args?.id;
      const dependency = {
        owner: authority.scope.owner,
        namespace: authority.scope.namespace,
        collection: name,
      };
      return intent.operation === "get" && typeof id === "string"
        ? [{ ...dependency, id }]
        : [
          dependency,
          ...(typeof id === "string" ? [{ ...dependency, id }] : []),
        ];
    },
    async get(
      tx: SqlExecutor,
      key: string,
      policy: OwnerPolicy,
      time: string,
      authority: AuthenticatedAuthority,
      intent: AuthorizationIntent,
    ): Promise<Entry | undefined> {
      const index = cachedAuthorization<Signatures>(
        tx,
        signatures,
        key,
      );
      if (!index) {
        cachedAuthorization(tx, scope, key); // One cold decision miss, no SQL.
        return;
      }
      // Policies see the session-clamped credential, exactly as on a cold call.
      // The index is stamped by the session row along with the decisions.
      let current = structuredClone(authority);
      if (
        current.validity.kind === "credential" && index.sessionExpiresAt &&
        Date.parse(index.sessionExpiresAt) <
          Date.parse(current.validity.expiresAt)
      ) {
        current = {
          ...current,
          validity: {
            ...current.validity,
            expiresAt: new Date(index.sessionExpiresAt).toISOString(),
          },
        };
      }
      for (const reads of index.paths) {
        const values = policyReadValues({ authority: current, intent }, reads);
        const saved = cachedAuthorization<Entry>(
          tx,
          scope,
          stableStringify([key, reads, values]),
        );
        if (
          !saved || !saved.lifetime.valid || saved.policy !== policy ||
          saved.revision !== policy.revision || Date.parse(time) >= saved.until
        ) continue;
        // Check this invocation's lease, never the lease from the cached request.
        if (
          authority.validity.kind === "attempt" &&
          !await ownerAttemptLive(tx, schema, authority.validity, time)
        ) return;
        // A retained audit view can be accessed while lease validation awaits.
        if (!saved.lifetime.valid) continue;
        const until = Math.min(
          saved.until,
          current.validity.kind === "credential"
            ? Date.parse(current.validity.expiresAt)
            : Infinity,
        );
        return {
          ...saved,
          until,
          decision: { ...structuredClone(saved.decision), authority: current },
        };
      }
    },
    remember(
      tx: SqlExecutor,
      key: string,
      policy: OwnerPolicy,
      decision: AuthorizationDecision,
      until: number,
      sessionExpiresAt: string | undefined,
      observations: {
        reads: PolicyReadSet;
        values: string;
        lifetime: { valid: boolean };
      },
    ) {
      const existing =
        cachedAuthorization<Signatures>(tx, signatures, key)?.paths ??
          [];
      const signature = stableStringify(observations.reads);
      const paths =
        existing.some((reads) => stableStringify(reads) === signature)
          ? existing
          : [...existing.slice(-7), observations.reads];
      rememberAuthorization(
        tx,
        signatures,
        key,
        { paths, sessionExpiresAt },
        sessionExpiresAt
          ? [authorizationTableKey(schema, "authorization_sessions")]
          : [],
      );
      rememberAuthorization(
        tx,
        scope,
        stableStringify([key, observations.reads, observations.values]),
        {
          decision: structuredClone(decision),
          policy,
          revision: policy.revision,
          until,
          lifetime: observations.lifetime,
        },
        [
          ...authorizationDependencyKeys(schema, decision.dependencies),
          ...(decision.authority.flow
            ? [authorizationTableKey(schema, "owner_receipts")]
            : []),
        ],
      );
    },
  };
}
