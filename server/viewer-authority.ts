/** Package-private authority minted by successful configured HTTP authentication. */
import type { FacadeContext } from "./context.ts";
import type { CollectionPolicyInvocation } from "../runtime/collections/policy-types.ts";
import { withOwnerCollectionInvocation } from "../runtime/collections/policy-invocation.ts";
import { captureHostCommandJson } from "../runtime/application/host-command-json.ts";
import { snapshotViewData } from "../runtime/views/renderer.ts";

type Viewer = Extract<CollectionPolicyInvocation, { kind: "viewer" }>;
type Binding = Readonly<{
  invocation: Viewer;
  scope: Readonly<{ namespace: string; databaseSchema: string }>;
}>;
const tokenKey = Symbol("server.viewer.authority");
const bindings = new WeakMap<object, Binding>();
const reads = new Set([
  "get",
  "list",
  "aggregate",
  "query",
  "search",
  "relations.list",
  "vectors.search",
]);

function denied(): never {
  throw Object.assign(
    new Error("Authenticated viewer authority is required."),
    {
      status: 403,
      code: "forbidden",
    },
  );
}

/** Only called after both configured host callbacks have succeeded. */
export function withAuthenticatedViewer<T extends FacadeContext>(
  context: T,
): T {
  const { actor, namespace, databaseSchema } = context.serverScope;
  const source = context.serverScope.context?.viewer;
  if (!actor || !namespace || !databaseSchema || !source) return context;
  if (typeof source !== "object" || Array.isArray(source)) denied();
  const token = Object.freeze({});
  const invocation = captureHostCommandJson(
    JSON.parse(JSON.stringify(snapshotViewData({
      kind: "viewer",
      id: context.serverEndpointKey,
      runId: crypto.randomUUID(),
      actor,
      claims: source,
    }, { maxDepth: 8, maxNodes: 128, maxBytes: 8192 }))),
  ) as Viewer;
  bindings.set(token, {
    invocation,
    scope: Object.freeze({ namespace, databaseSchema }),
  });
  // Context copies retain this symbol; JSON/wire objects cannot supply the token.
  return Object.assign(context, { [tokenKey]: token });
}

function binding(context: FacadeContext): Binding | undefined {
  const token = (context as FacadeContext & { [tokenKey]?: object })[tokenKey];
  if (!token) return undefined;
  const value = bindings.get(token);
  if (!value) denied();
  return value;
}

export function viewerIdentity(context: FacadeContext): string {
  const value = binding(context) ?? denied();
  return JSON.stringify([
    value.scope.databaseSchema,
    value.scope.namespace,
    value.invocation.actor.id,
    value.invocation.actor.externalId ?? null,
    value.invocation.claims,
  ]);
}

/** Every call installs a fresh, revocable, read-only owner policy invocation. */
export function withServerViewerRead<T>(
  context: FacadeContext | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  const value = context && binding(context);
  // Authentication's own lookups keep their existing trusted-read scope.
  // A collection requiring policy still fails closed without a bound viewer.
  if (!value) return Promise.resolve().then(run);
  const signal = context!.serverSignal;
  return withOwnerCollectionInvocation({
    ...value,
    signal,
    check: () => signal.throwIfAborted(),
    resolveSource: () =>
      Promise.reject(new Error("A viewer has no Action source.")),
    authorizeIntent(intent) {
      if (intent.phase === "mutation" || !reads.has(intent.method)) denied();
      return Promise.resolve();
    },
  }, run);
}
