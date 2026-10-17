/** Private ordinary Resource projection for named preparation. Resource policy
 * owns authorization of each original identity/version, including on replay.
 * It is not a resolver for worker-authored resource names or values. */
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";
import { digestContent } from "../content/digest.ts";
import { assertJsonValue } from "../json.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { OwnerCaller, OwnerJson } from "./boundary.ts";
import type { PreparationSourceScope } from "./preparation-source.ts";
import type { PreparationResourceReference } from "./preparation-capture.ts";

export type PreparationResourceCoordinate = Readonly<
  { namespace: string; alias: string }
>;
export type PreparationResourceContext = Readonly<{
  caller: OwnerCaller;
  scope: PreparationSourceScope;
  commandTime: string;
  signal: AbortSignal;
}>;
export type OwnerPreparationResourcesOptions = Readonly<{
  registry: Pick<PluginRegistry, "resources">;
  /** Registered owner-local allowlist, never accepted from a command payload. */
  resources: readonly PreparationResourceCoordinate[];
  projectResource(
    tx: SqlExecutor,
    context: Readonly<{
      caller: OwnerCaller;
      scope: PreparationSourceScope;
      resource: PreparationResourceCoordinate;
      value: OwnerJson;
      commandTime: string;
    }>,
  ): OwnerJson | Promise<OwnerJson>;
  /** Must check current scope against this ORIGINAL authorized version. Do not
   * infer permission from a digest or replace it with today's registry value. */
  authorizeResource(
    tx: SqlExecutor,
    context: Readonly<{
      caller: OwnerCaller;
      scope: PreparationSourceScope;
      reference: PreparationResourceReference;
      purpose: "capture" | "duplicate" | "input" | "result";
      commandTime: string;
    }>,
  ): true | Promise<true>;
  maxBytes?: number;
}>;
function fail(code = "preparation_resource_invalid"): never {
  throw Object.assign(new Error(code), { code });
}
function name(value: unknown): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 512
  ) fail();
  return value;
}
function coordinate(value: unknown): PreparationResourceCoordinate {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 || !Object.hasOwn(data, "namespace") ||
    !Object.hasOwn(data, "alias")
  ) fail();
  return { namespace: name(data.namespace), alias: name(data.alias) };
}
function key(value: PreparationResourceCoordinate): string {
  return JSON.stringify([value.namespace, value.alias]);
}
function snapshot(value: unknown, maxBytes: number): OwnerJson {
  assertJsonValue(value, { maxDepth: 32, maxNodes: 20_000 });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
    fail("preparation_limit");
  }
  return structuredClone(value) as OwnerJson;
}
function ordinary(value: OwnerJson): void {
  try {
    assertOwnerOrdinaryValue(value);
  } catch (error) {
    if (
      error && typeof error === "object" && "code" in error &&
      error.code === "ordinary_value_unsupported"
    ) {
      fail("preparation_unsupported");
    }
    throw error;
  }
}

function canonical(value: OwnerJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((name) =>
        `${JSON.stringify(name)}:${
          canonical((value as Record<string, OwnerJson>)[name])
        }`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
export function createOwnerPreparationResources(
  options: OwnerPreparationResourcesOptions,
) {
  const maxBytes = options.maxBytes ?? 65_536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
    fail();
  }
  const resources = snapshot(
    options.resources,
    maxBytes,
  ) as readonly OwnerJson[];
  if (resources.length > 32) fail("preparation_limit");
  const coordinates = resources.map(coordinate);
  const allowed = new Set(coordinates.map(key));
  if (allowed.size !== coordinates.length) fail();
  const projectResource = options.projectResource;
  const authorizeResource = options.authorizeResource;
  const registry = options.registry;
  function references(value: unknown): PreparationResourceReference[] {
    const data = snapshot(value, maxBytes);
    if (!Array.isArray(data) || data.length > 32) fail();
    const seen = new Set<string>();
    return data.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) fail();
      const raw = item as Record<string, OwnerJson>;
      if (
        Object.keys(raw).length !== 3 || !Object.hasOwn(raw, "namespace") ||
        !Object.hasOwn(raw, "alias") || !Object.hasOwn(raw, "digest")
      ) fail();
      const ref = {
        namespace: name(raw.namespace),
        alias: name(raw.alias),
        digest: raw.digest,
      };
      if (
        typeof ref.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(ref.digest)
      ) fail();
      const id = key(ref);
      if (!allowed.has(id) || seen.has(id)) {
        fail("preparation_resource_forbidden");
      }
      seen.add(id);
      return ref as PreparationResourceReference;
    });
  }
  async function authorize(
    tx: SqlExecutor,
    input: readonly PreparationResourceReference[],
    context: PreparationResourceContext,
    purpose: "capture" | "duplicate" | "input" | "result",
  ): Promise<void> {
    const caller = structuredClone(context.caller);
    const scope = structuredClone(context.scope);
    const signal = context.signal;
    const commandTime = context.commandTime;
    signal.throwIfAborted();
    for (const reference of references(input)) {
      signal.throwIfAborted();
      if (
        await authorizeResource(tx, {
          caller: structuredClone(caller),
          scope: structuredClone(scope),
          reference: structuredClone(reference),
          purpose,
          commandTime,
        }) !== true
      ) fail("preparation_resource_forbidden");
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
  }
  return {
    authorize,
    async capture(
      tx: SqlExecutor,
      context: PreparationResourceContext,
    ): Promise<
      Readonly<{
        values: Readonly<Record<string, Readonly<Record<string, OwnerJson>>>>;
        references: readonly PreparationResourceReference[];
      }>
    > {
      const signal = context.signal;
      const commandTime = context.commandTime;
      signal.throwIfAborted();
      const caller = structuredClone(context.caller);
      const scope = structuredClone(context.scope);
      const values: Record<string, Record<string, OwnerJson>> = Object.create(
        null,
      );
      const captured: PreparationResourceReference[] = [];
      for (const resource of coordinates) {
        signal.throwIfAborted();
        const group = Object.hasOwn(registry.resources, resource.namespace)
          ? registry.resources[resource.namespace]
          : undefined;
        if (!group || !Object.hasOwn(group, resource.alias)) {
          fail("preparation_resource_missing");
        }
        const value = snapshot(group[resource.alias], maxBytes);
        const projected = snapshot(
          await projectResource(tx, {
            caller: structuredClone(caller),
            scope: structuredClone(scope),
            resource: { ...resource },
            value,
            commandTime,
          }),
          maxBytes,
        );
        ordinary(projected);
        signal.throwIfAborted();
        const reference = {
          ...resource,
          digest: await digestContent(
            new TextEncoder().encode(canonical(projected)),
          ),
        };
        (values[resource.namespace] ??= Object.create(null))[resource.alias] =
          projected;
        captured.push(reference);
        snapshot({ values, references: captured }, maxBytes);
      }
      await authorize(
        tx,
        captured,
        { caller, scope, signal, commandTime },
        "capture",
      );
      return snapshot({ values, references: captured }, maxBytes) as {
        values: Record<string, Record<string, OwnerJson>>;
        references: PreparationResourceReference[];
      };
    },
  };
}
