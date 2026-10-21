/** The chat shell: navigation state, sidebar, header, panel and Spaces. @module */
import type {
  ActionHandle,
  BrowserActionContext,
  BrowserPlugin,
  BrowserRuntime,
  ClientCollectionDefinition,
} from "@copilotz/copilotz/web";
import type { ViewHints, ViewReference } from "@copilotz/copilotz/views";
import { coreWebPlugin } from "@copilotz/copilotz/core/web";
import shell from "./views/shell/index.tsx";
import sidebar from "./views/sidebar/index.tsx";
import header from "./views/header/index.tsx";
import space from "./views/space/index.tsx";
import spaceOverview from "./views/space-overview/index.tsx";
import spaceConversations from "./views/space-conversations/index.tsx";
import spaceMembers from "./views/space-members/index.tsx";
import userProfile from "./views/profile/index.tsx";
import panel from "./views/panel/index.tsx";
import palette from "./views/palette/index.tsx";
import { initialShell, shellPreferences, shellState } from "./model.ts";

export * from "./model.ts";
export {
  header,
  palette,
  panel,
  shell,
  sidebar,
  space,
  spaceConversations,
  spaceMembers,
  spaceOverview,
  userProfile,
};

export interface UiWebOptions {
  /** The storage adapter name for navigation (usually the URL). */
  navigation?: string;
  /** The storage adapter name for per-device preferences (local storage). */
  preferences?: string;
  /** The core browser plugin instance the app composes (default `coreWebPlugin`). */
  core?: BrowserPlugin;
}

const set: NonNullable<ClientCollectionDefinition["commands"]>[string] = {
  mutate: ({ input }) => ({ set: { ...(input as Record<string, unknown>) } }),
};

function navigate(ctx: BrowserActionContext, patch: Record<string, unknown>) {
  const current = shellState(ctx.collections.shell.get("main").value);
  ctx.command("shell", "main", "set", {
    ...shellState({ ...current, ...patch }),
    origin: "app",
  });
}

const browser = (
  id: string,
  execute: (input: unknown, ctx: BrowserActionContext) => unknown,
) => ({ id, placement: "browser" as const, execute });

/** The shell plugin: compose it with the app's root plugin. */
export function uiWebPlugin(options: UiWebOptions = {}): BrowserPlugin {
  return {
    id: "@copilotz/ui",
    plugins: [options.core ?? coreWebPlugin],
    collections: {
      shell: {
        placement: "browser",
        storage: options.navigation,
        initial: [{ id: "main", ...initialShell }],
        commands: { set },
      },
      shellPreferences: {
        placement: "browser",
        storage: options.preferences,
        initial: [{ id: "main", ...shellPreferences({}) }],
        commands: { set },
      },
      // Memory only: open dialogs, the palette, toasts.
      shellOverlay: {
        placement: "browser",
        initial: [{
          id: "main",
          palette: false,
          dialog: null,
          createSpace: false,
        }],
        commands: { set },
      },
      shellToasts: { placement: "browser", initial: [], commands: { set } },
      // Whether the signed-in session is still valid (see `bindShellSession`).
      shellSession: { placement: "browser", initial: [], commands: { set } },
    },
    actions: {
      shellOpenThread: browser(
        "ui.shell.openThread",
        (input, ctx) =>
          navigate(ctx, {
            threadId: (input as { threadId: string }).threadId,
            spaceId: null,
            newIn: null,
            page: null,
          }),
      ),
      shellOpenSpace: browser("ui.shell.openSpace", (input, ctx) => {
        const { spaceId, section } = input as {
          spaceId: string;
          section?: string;
        };
        const from = shellState(ctx.collections.shell.get("main").value);
        navigate(ctx, {
          spaceId,
          page: null,
          // A page's section never carries over into a Space.
          ...(section ? { section } : from.page ? { section: null } : {}),
        });
      }),
      shellCloseSpace: browser(
        "ui.shell.closeSpace",
        (_input, ctx) => navigate(ctx, { spaceId: null }),
      ),
      shellNewChat: browser("ui.shell.newChat", (input, ctx) =>
        navigate(ctx, {
          threadId: null,
          spaceId: null,
          page: null,
          newIn: (input as { spaceId?: string } | undefined)?.spaceId ?? null,
        })),
      shellOpenPage: browser("ui.shell.openPage", (input, ctx) => {
        const { page, section } = input as {
          page: string | null;
          section?: string | null;
        };
        navigate(ctx, { page, section: section ?? null, spaceId: null });
      }),
      shellSection: browser(
        "ui.shell.section",
        (input, ctx) =>
          navigate(ctx, { section: (input as { section: string }).section }),
      ),
      shellPanel: browser(
        "ui.shell.panel",
        (input, ctx) =>
          navigate(ctx, { panel: (input as { open: boolean }).open }),
      ),
      shellPreference: browser("ui.shell.preference", (input, ctx) => {
        const current = ctx.collections.shellPreferences.get("main").value;
        ctx.command("shellPreferences", "main", "set", {
          ...shellPreferences({ ...current, ...(input as object) }),
        });
      }),
      shellOverlay: browser(
        "ui.shell.overlay",
        (input, ctx) =>
          ctx.command("shellOverlay", "main", "set", input as object),
      ),
      shellPalette: browser(
        "ui.shell.palette",
        (input, ctx) =>
          ctx.command("shellOverlay", "main", "set", {
            palette: (input as { open: boolean }).open,
          }),
      ),
      shellDialog: browser(
        "ui.shell.dialog",
        (input, ctx) =>
          ctx.command("shellOverlay", "main", "set", {
            dialog: (input as { reference: ViewReference | null }).reference ??
              null,
          }),
      ),
      shellToast: browser("ui.shell.toast", (input, ctx) => {
        const { text, tone = "info" } = input as {
          text: string;
          tone?: "info" | "error";
        };
        ctx.command("shellToasts", crypto.randomUUID(), "set", {
          text,
          tone,
          at: Date.now(),
          removed: false,
        });
      }),
      shellDismissToast: browser(
        "ui.shell.dismissToast",
        (input, ctx) =>
          ctx.command("shellToasts", (input as { id: string }).id, "set", {
            removed: true,
          }),
      ),
      // The session ended (the device revoked it): the shell shows sign-in
      // and opens no reads until `shellSessionRestored`. Nothing reconnects
      // by itself.
      shellSessionEnded: browser(
        "ui.shell.sessionEnded",
        (input, ctx) =>
          ctx.command("shellSession", "main", "set", {
            state: "revoked",
            code: String(
              (input as { code?: unknown } | undefined)?.code ??
                "session_revoked",
            ),
          }),
      ),
      shellSessionRestored: browser(
        "ui.shell.sessionRestored",
        (_input, ctx) =>
          ctx.command("shellSession", "main", "set", { state: "active" }),
      ),
    },
    views: {
      shell,
      sidebar,
      header,
      panel,
      palette,
      space,
      spaceOverview,
      spaceConversations,
      spaceMembers,
      userProfile,
    },
    resources: {
      spaceSections: {
        overview: {
          label: "Overview",
          icon: "book",
          order: 0,
          view: "spaceOverview",
        },
        conversations: {
          label: "Chats",
          icon: "message",
          order: 10,
          view: "spaceConversations",
        },
        members: {
          label: "Members",
          icon: "users",
          order: 90,
          view: "spaceMembers",
        },
      },
    },
  };
}

/**
 * The host `show` port for the shell: `ctx.show(ref, { source: "link" })`
 * opens conversations and Spaces in place, a View with `region: "main"` as a
 * page (its value is `null` or `{ section }`), and any other View in the
 * dialog.
 */
export function shellNavigation(
  runtime: () => BrowserRuntime,
): (reference: ViewReference, hints: ViewHints) => ActionHandle | undefined {
  return (reference, hints) => {
    const actions = runtime().actions;
    const value = reference.value as Record<string, unknown> | null;
    if (reference.shows === "thread" && typeof value?.id === "string") {
      return actions.shellOpenThread({ threadId: value.id });
    }
    if (reference.shows === "space" && typeof value?.spaceId === "string") {
      return actions.shellOpenSpace({
        spaceId: value.spaceId,
        ...(typeof value.section === "string"
          ? { section: value.section }
          : {}),
      });
    }
    // `region: "main"` opens a View as a page; its value may name a section.
    if (
      hints.region === "main" && typeof reference.shows === "string" &&
      (value === null ||
        (Object.keys(value).every((key) => key === "section") &&
          (value.section === undefined || typeof value.section === "string")))
    ) {
      return actions.shellOpenPage({
        page: reference.shows,
        section: (value?.section as string | undefined) ?? null,
      });
    }
    if (reference.shows === "newThread") {
      return actions.shellNewChat(
        typeof value?.spaceId === "string" ? { spaceId: value.spaceId } : {},
      );
    }
    if (hints.region === "panel") return actions.shellPanel({ open: true });
    return actions.shellDialog({
      reference: { shows: reference.shows, value: reference.value },
    });
  };
}

/** A device transport's auth state, as `createDeviceTransport` reports it. */
export interface ShellAuthSource {
  onAuthState(
    listener: (event: Readonly<{ state: string; code?: string }>) => void,
  ): () => void;
}

/**
 * Connects the device's auth state to the shell: when the session is revoked
 * the shell replaces itself with sign-in (`resources.shell.signIn`) and stops
 * reading. The app signs in again, calls `device.reauthenticate()`, then
 * `runtime.actions.shellSessionRestored({})`. Returns the unsubscribe.
 */
export function bindShellSession(
  runtime: Pick<BrowserRuntime, "actions">,
  auth: ShellAuthSource,
): () => void {
  return auth.onAuthState((event) => {
    if (event.state !== "revoked") return;
    void runtime.actions.shellSessionEnded({ code: event.code }).result()
      .catch(() => {});
  });
}
