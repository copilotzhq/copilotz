/** Generic, synchronous authoring contributions. No plugin semantics live here. @module */
import type { ActionMap } from "../actions/types.ts";
import type {
  AnyCopilotzPlugin,
  CollectionMap,
  PluginNamespaceMap,
  ProcessorMap,
} from "./types.ts";

export const contribution = Symbol.for("copilotz.composition.contribution");

export interface ContributionResult<
  T = unknown,
  A extends ActionMap = ActionMap,
  P extends readonly AnyCopilotzPlugin[] = readonly [],
> {
  value: T;
  plugins?: P;
  actions?: A;
  collections?: CollectionMap;
  processors?: ProcessorMap;
  resources?: PluginNamespaceMap;
  adapters?: PluginNamespaceMap;
}

export interface CompositionContribution<
  T = unknown,
  A extends ActionMap = ActionMap,
  P extends readonly AnyCopilotzPlugin[] = readonly [],
> {
  [contribution](
    location: { namespace: string; alias: string },
  ): ContributionResult<T, A, P>;
}

export function isContribution(
  value: unknown,
): value is CompositionContribution<
  unknown,
  ActionMap,
  readonly AnyCopilotzPlugin[]
> {
  return value !== null && typeof value === "object" &&
    typeof (value as CompositionContribution<
        unknown,
        ActionMap,
        readonly AnyCopilotzPlugin[]
      >)[contribution] === "function";
}

export type ResolvedNamespaces<T extends PluginNamespaceMap> = {
  readonly [N in keyof T]: {
    readonly [K in keyof T[N]]: T[N][K] extends
      CompositionContribution<infer V, ActionMap, readonly AnyCopilotzPlugin[]>
      ? V
      : T[N][K];
  };
};

/** Copy containers before expansion so declarations can be reused by multiple apps. */
export function resolveContributions(input: {
  actions?: ActionMap;
  collections?: CollectionMap;
  processors?: ProcessorMap;
  resources?: PluginNamespaceMap;
  adapters?: PluginNamespaceMap;
}) {
  const copy = (map: PluginNamespaceMap = {}) =>
    Object.fromEntries(
      Object.entries(map).map(([name, values]) => [name, { ...values }]),
    );
  const output = {
    actions: { ...input.actions },
    collections: { ...input.collections },
    processors: { ...input.processors },
    resources: copy(input.resources),
    adapters: copy(input.adapters),
    plugins: [] as AnyCopilotzPlugin[],
  };
  function merge(
    target: Record<string, unknown>,
    values: object,
    label: string,
  ) {
    for (const [key, value] of Object.entries(values)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new TypeError(`Invalid contribution key ${key}.`);
      }
      if (Object.hasOwn(target, key)) {
        throw new TypeError(`Contribution conflicts at ${label}.${key}.`);
      }
      target[key] = value;
    }
  }
  for (const category of ["resources", "adapters"] as const) {
    for (const [namespace, entries] of Object.entries(output[category])) {
      for (const [alias, declaration] of Object.entries(entries)) {
        if (
          declaration && typeof declaration === "object" &&
          "then" in declaration
        ) {
          throw new TypeError(
            `Resource ${namespace}.${alias} is unresolved; await its declaration before composition.`,
          );
        }
        if (!isContribution(declaration)) continue;
        const result = declaration[contribution]({ namespace, alias });
        if (
          !result || typeof result !== "object" || "then" in result ||
          !("value" in result)
        ) {
          throw new TypeError(
            `Contribution ${namespace}.${alias} must resolve synchronously.`,
          );
        }
        if (isContribution(result.value)) {
          throw new TypeError("Contributions must resolve to native values.");
        }
        entries[alias] = result.value;
        if (result.plugins) {
          if (!Array.isArray(result.plugins)) {
            throw new TypeError("Contribution plugins must be an array.");
          }
          output.plugins.push(...result.plugins);
        }
        for (const kind of ["actions", "collections", "processors"] as const) {
          merge(output[kind], result[kind] ?? {}, kind);
        }
        for (const kind of ["resources", "adapters"] as const) {
          for (const [name, values] of Object.entries(result[kind] ?? {})) {
            if (["__proto__", "constructor", "prototype"].includes(name)) {
              throw new TypeError(`Invalid contribution namespace ${name}.`);
            }
            if (
              !values || typeof values !== "object" || Array.isArray(values)
            ) {
              throw new TypeError(
                `Contribution ${kind}.${name} must be a namespace map.`,
              );
            }
            if (Object.values(values).some(isContribution)) {
              throw new TypeError(
                "Contributions must emit native values, not nested contributions.",
              );
            }
            merge(output[kind][name] ??= {}, values, `${kind}.${name}`);
          }
        }
      }
    }
  }
  return output;
}

type ActionsOf<T, Alias extends PropertyKey> = T extends
  CompositionContribution<unknown, infer A, readonly AnyCopilotzPlugin[]>
  ? string extends keyof A ? { readonly [K in Alias]: A[string] } : A
  : {};
type Intersection<T> = (T extends unknown ? (value: T) => void : never) extends
  (value: infer I) => void ? I : {};
export type ContributionActions<T extends PluginNamespaceMap> =
  & Intersection<
    {
      [N in keyof T]-?: {
        [K in keyof T[N]]-?: ActionsOf<T[N][K], K>;
      }[keyof T[N]];
    }[keyof T]
  >
  & {};

type PluginsOf<T> = T extends
  CompositionContribution<unknown, ActionMap, infer P> ? P[number] : never;
type NamespacePlugins<T extends PluginNamespaceMap> = {
  [N in keyof T]-?: { [K in keyof T[N]]-?: PluginsOf<T[N][K]> }[keyof T[N]];
}[keyof T];
/** Dependencies supplied by resource declarations participate in normal composition. */
export type ContributionPlugins<T extends PluginNamespaceMap> =
  [Extract<NamespacePlugins<T>, AnyCopilotzPlugin>] extends [never]
    ? readonly []
    : readonly Extract<NamespacePlugins<T>, AnyCopilotzPlugin>[];
