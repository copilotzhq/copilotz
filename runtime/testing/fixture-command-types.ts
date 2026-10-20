import type { SqlExecutor } from "../events/session.ts";

/** Bounded immutable JSON captured at the trusted host admission boundary. */
export type HostCommandJson =
  | null
  | boolean
  | number
  | string
  | readonly HostCommandJson[]
  | { readonly [key: string]: HostCommandJson };

/** Fixed host identity and scope are metadata, not SQL sandboxing. */
export type HostCommandContext = Readonly<{
  query: SqlExecutor["query"];
  scope: Readonly<
    { databaseSchema: string; namespace: string; principal: string }
  >;
  commandTime: string;
  signal: AbortSignal;
  afterCommit(callback: () => void | Promise<void>): void;
}>;

/** Trusted local callbacks. HTTP/session authorization belongs to the embedding host. */
export type HostCommandDefinition<
  Input = HostCommandJson,
  Output = HostCommandJson,
> = Readonly<{
  databaseSchema?: string;
  namespace: string;
  /** Identifies the host service, not an authenticated end user. */
  principal: string;
  /** Policy/read phase; runs again on replay. Throw to reject. */
  authorize(input: Input, context: HostCommandContext): void | Promise<void>;
  execute(input: Input, context: HostCommandContext): Output | Promise<Output>;
}>;

// Method parameters deliberately preserve inference for explicitly typed inputs.
export type HostCommandDefinitions = Readonly<
  Record<string, HostCommandDefinition<unknown, unknown>>
>;
export type HostCommandOptions = Readonly<{ idempotencyKey?: string }>;
export type HostCommands<
  T extends HostCommandDefinitions = HostCommandDefinitions,
> = Readonly<{
  invoke<K extends keyof T & string>(
    name: K,
    input: Parameters<T[K]["execute"]>[0],
    options?: HostCommandOptions,
  ): Promise<Awaited<ReturnType<T[K]["execute"]>>>;
}>;
