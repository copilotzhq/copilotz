import type { ViewReference } from "@copilotz/copilotz/views";
import type { StorageAdapter } from "@copilotz/copilotz/web";

export type WorkspaceRegion = "focus" | "context" | "dialog";
export interface WorkspaceState {
  focus: ViewReference | null;
  context: ViewReference | null;
  dialog: ViewReference | null;
}

/** Normalize a complete snapshot, clearing every omitted pane. */
export function workspaceState(input: unknown): WorkspaceState {
  const state = input as Partial<WorkspaceState> | null | undefined;
  return {
    focus: state?.focus ?? null,
    context: state?.context ?? null,
    dialog: state?.dialog ?? null,
  };
}

/** The app maps references to readable paths and query parameters. */
export interface WorkspaceUrlCodec {
  decode(url: URL): WorkspaceState | undefined;
  /** Mutate this URL; unrelated host parameters should be preserved. */
  encode(url: URL, state: WorkspaceState): void;
}

/** Plugin-level URL hook using the existing browser storage port. */
export function workspaceUrlStorageAdapter(
  host: { read(): URL; replace(url: URL): void },
  codec: WorkspaceUrlCodec,
): StorageAdapter {
  return {
    load() {
      const state = codec.decode(new URL(host.read()));
      return state === undefined
        ? undefined
        : [{ id: "main", ...workspaceState(state) }];
    },
    save(_key, rows) {
      const state = rows.find((row) => row.id === "main");
      const url = new URL(host.read());
      codec.encode(url, workspaceState(state));
      host.replace(url);
    },
  };
}
