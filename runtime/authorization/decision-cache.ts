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

type Entry = {
  decision: AuthorizationDecision;
  policy: OwnerPolicy;
  revision: string;
  until: number;
};
export function createDecisionReuse(schema: string) {
  const scope = { cache: "evaluation" };
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
      // Policy can inspect provenance, request facts and invocation as well as
      // principal/validity. Never merge authorities or intents that differ there.
      return stableStringify([authority, intent]);
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
    ): Promise<Entry | undefined> {
      const saved = cachedAuthorization<Entry>(tx, scope, key);
      if (
        !saved || saved.policy !== policy ||
        saved.revision !== policy.revision || Date.parse(time) >= saved.until
      ) return;
      const validity = saved.decision.authority.validity;
      if (
        validity.kind === "attempt" &&
        !await ownerAttemptLive(tx, schema, validity, time)
      ) return;
      return { ...saved, decision: structuredClone(saved.decision) };
    },
    remember(
      tx: SqlExecutor,
      key: string,
      policy: OwnerPolicy,
      decision: AuthorizationDecision,
      until: number,
    ) {
      rememberAuthorization(tx, scope, key, {
        decision: structuredClone(decision),
        policy,
        revision: policy.revision,
        until,
      }, [
        ...authorizationDependencyKeys(schema, decision.dependencies),
        ...(decision.authority.flow
          ? [authorizationTableKey(schema, "owner_receipts")]
          : []),
      ]);
    },
  };
}
