import type { CollectionContentOptions } from "../../runtime/collections/read-options.ts";
import type {
  ViewEnvironment,
  ViewHints,
  ViewMap,
  ViewReference,
} from "../../runtime/views/definition.ts";
import type { CollectionCommandDefinition } from "../../runtime/collections/definition.ts";
import type { LiveReadPort, Row } from "./live.ts";
export type Placement = "server" | "browser" | "both";
export type ReadState<T = unknown> = Readonly<{
  value: T;
  status: "loading" | "ready" | "missing" | "stale" | "denied";
  pending: boolean;
}>;
export interface ClientCollection {
  get(
    id: string,
    options?: { content?: CollectionContentOptions },
  ): ReadState<Row | undefined>;
  list(
    query?: Readonly<Record<string, unknown>>,
    options?: { content?: CollectionContentOptions },
  ): ReadState<readonly Row[]>;
}
export interface ClientCollectionDefinition {
  placement: Placement;
  initial?: readonly Row[];
  storage?: string;
  commands?: Readonly<Record<string, CollectionCommandDefinition<Row>>>;
}
export interface StorageAdapter {
  load(
    key: string,
  ): readonly Row[] | undefined | Promise<readonly Row[] | undefined>;
  save(key: string, rows: readonly Row[]): void | Promise<void>;
}
export type ActionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export interface ActionHandle {
  readonly id: string;
  readonly status: ActionStatus;
  readonly error: unknown;
  result(): Promise<unknown>;
  cancel(): Promise<void>;
}
export interface BrowserViewContext extends ViewEnvironment {
  readonly adapters: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly collections: Readonly<Record<string, ClientCollection>>;
  readonly actions: Readonly<Record<string, (input: unknown) => ActionHandle>>;
  show(reference: ViewReference, hints?: ViewHints): unknown;
  readAction(alias: string, input: unknown): ReadState;
}
export interface BrowserActionContext extends BrowserViewContext {
  command(
    collection: string,
    id: string,
    command: string,
    input: unknown,
  ): void;
}
export interface BrowserActionDefinition {
  id: string;
  placement: Placement;
  execute?(
    input: unknown,
    ctx: BrowserActionContext,
  ): unknown | Promise<unknown>;
  query?: { reads: readonly string[] };
  optimistic?: {
    collection: string;
    command: string;
    id(input: unknown): string;
    input?(input: unknown): unknown;
  };
}
export interface BrowserProcessor {
  placement: Placement;
  on: string;
  handle(event: ClientEvent, ctx: BrowserActionContext): void | Promise<void>;
}
export interface BrowserPlugin {
  id: string;
  plugins?: readonly BrowserPlugin[];
  collections?: Readonly<Record<string, ClientCollectionDefinition>>;
  actions?: Readonly<Record<string, BrowserActionDefinition>>;
  processors?: Readonly<Record<string, BrowserProcessor>>;
  views?: ViewMap;
  resources?: BrowserViewContext["resources"];
  adapters?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
export interface ActionTransport {
  /** Resolve only at terminal success, with the last owner command sequence. */
  invoke(
    id: string,
    input: unknown,
    options: {
      idempotencyKey: string;
      signal: AbortSignal;
      accepted(operationId: string): void;
    },
  ): Promise<{ value: unknown; seq: number }>;
  cancel(operationId: string): Promise<void>;
}
export interface ClientEvent {
  readonly index: number;
  readonly type: string;
  readonly collection?: string;
  readonly id?: string;
}
export interface Observation<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
export interface BrowserRuntimeOptions {
  plugins: readonly BrowserPlugin[];
  live?: LiveReadPort;
  actions?: ActionTransport;
  storage?: Readonly<Record<string, StorageAdapter>>;
  adapters?: BrowserViewContext["adapters"];
  renderer?: import("../../runtime/views/renderer.ts").ViewRendererAdapter;
  scope?: unknown;
  show?(reference: ViewReference, hints: ViewHints): unknown;
  onError?(error: unknown): void;
}

export interface BrowserRuntime {
  readonly collections: Readonly<Record<string, ClientCollection>>;
  readonly actions: Readonly<Record<string, (input: unknown) => ActionHandle>>;
  readonly events: readonly ClientEvent[];
  render(reference: ViewReference, hints?: ViewHints): unknown;
  observe<T>(evaluate: (ctx: BrowserViewContext) => T): Observation<T>;
  onEvent(listener: (event: ClientEvent) => void): () => void;
  flushStorage(): Promise<void>;
  mount(
    target: unknown,
    root: ViewReference,
    hints?: ViewHints,
  ): { dispose(): void };
  dispose(): void;
}
