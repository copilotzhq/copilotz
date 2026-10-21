import type { ViewReference } from "@copilotz/copilotz/views";
import { type StorageAdapter, urlReference } from "@copilotz/copilotz/web";

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

/**
 * The app maps references to readable paths and query parameters. Encode
 * identifiers and plain navigation scalars only; records are read again by the
 * View, never decoded from the URL.
 */
export interface WorkspaceUrlCodec {
  decode(url: URL): WorkspaceState | undefined;
  /** Mutate this URL; unrelated host parameters should be preserved. */
  encode(url: URL, state: WorkspaceState): void;
}

/**
 * Plugin-level URL hook using the existing browser storage port. Every decoded
 * pane passes `urlReference`: a pane whose value is not identifiers and plain
 * scalars is dropped, and the rest render only with Views that declare `url`.
 * With `events`, browser history navigation restores through the same check.
 */
export function workspaceUrlStorageAdapter(
  host: {
    read(): URL;
    replace(url: URL): void;
    events?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  },
  codec: WorkspaceUrlCodec,
): StorageAdapter {
  return {
    ...(host.events
      ? {
        subscribe(listener: () => void) {
          host.events!.addEventListener("popstate", listener);
          return () => host.events!.removeEventListener("popstate", listener);
        },
      }
      : {}),
    load() {
      const state = codec.decode(new URL(host.read()));
      if (state === undefined) return undefined;
      const { focus, context, dialog } = workspaceState(state);
      return [{
        id: "main",
        focus: urlReference(focus),
        context: urlReference(context),
        dialog: urlReference(dialog),
      }];
    },
    save(_key, rows) {
      const state = rows.find((row) => row.id === "main");
      const url = new URL(host.read());
      codec.encode(url, workspaceState(state));
      host.replace(url);
    },
  };
}
