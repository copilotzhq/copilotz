/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect } from "react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { ViewReference } from "@copilotz/copilotz/views";
import {
  type BrowserViewContext,
  type Row,
  urlReference,
} from "@copilotz/copilotz/web";
import {
  browser,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  domEvent,
  EmptyState,
  mediaMatches,
  showSafely,
  TooltipProvider,
} from "@copilotz/copilotz/web/kit";
import { LockKeyhole } from "lucide-react";
import { resolveDarkMode, shellPreferences, shellState } from "../../model.ts";
import { Toaster } from "../../components/toaster.tsx";

/** Applies the theme preference to the document, following the system for `system`. */
function Theme(
  { theme }: { theme: "light" | "dark" | "system" },
): null {
  useEffect(() => {
    const root = browser.document?.documentElement;
    if (!root) return;
    const media = browser.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () =>
      root.classList.toggle(
        "dark",
        resolveDarkMode(theme, media?.matches ?? false),
      );
    apply();
    if (theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return null;
}

const wide = () =>
  browser.matchMedia ? mediaMatches("(min-width: 1024px)") : true;

/** ⌘K search, ⌘B sidebar, ⌘. panel, Escape closes an overlaying panel. */
function Shortcuts(
  { ctx, sidebar, panel }: {
    ctx: BrowserViewContext;
    sidebar: "auto" | "expanded" | "rail";
    panel: boolean;
  },
): null {
  useEffect(() => {
    const handler = (raw: unknown) => {
      const event = domEvent(raw);
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        ctx.actions.shellPalette({ open: true });
      } else if (mod && event.key.toLowerCase() === "b") {
        event.preventDefault();
        ctx.actions.shellPreference({ sidebar: nextSidebar(sidebar) });
      } else if (mod && event.key === ".") {
        event.preventDefault();
        ctx.actions.shellPanel({ open: !panel });
      } else if (
        event.key === "Escape" && !event.defaultPrevented && !wide()
      ) {
        const open = browser.document?.querySelector('[role="dialog"]');
        if (open) return;
        if (panel) ctx.actions.shellPanel({ open: false });
        else if (sidebar === "expanded") {
          ctx.actions.shellPreference({ sidebar: "auto" });
        }
      }
    };
    browser.addEventListener("keydown", handler);
    return () => browser.removeEventListener("keydown", handler);
  }, [sidebar, panel]);
  return null;
}

/** Toggle between the expanded sidebar and the icon rail at the current width. */
export function nextSidebar(
  current: "auto" | "expanded" | "rail",
): "auto" | "expanded" | "rail" {
  const expanded = current === "expanded" || (current === "auto" && wide());
  // Collapsing on a wide screen keeps the rail; on a narrow one, `auto` is the rail.
  return expanded ? (wide() ? "rail" : "auto") : "expanded";
}

/** A reference from URL state renders only with Views that declare `url`. */
export function navReference(
  reference: ViewReference,
  origin: "app" | "url",
): ViewReference {
  return origin === "url" ? urlReference(reference) ?? reference : reference;
}

/** A sign-in link the app configured: relative, or http(s). */
function signInHref(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session ended: the app's sign-in View (`resources.shell.signIn.view`),
 * or a calm screen with its sign-in link (`href`) or Action (`action`). It
 * reads nothing, so no read retries against the ended session.
 */
function SignedOut(
  { ctx, code }: { ctx: BrowserViewContext; code: string },
): React.ReactElement {
  const signIn = ((ctx.resources.shell as Record<string, unknown> | undefined)
    ?.signIn ?? {}) as Record<string, unknown>;
  if (typeof signIn.view === "string") {
    return (
      <div data-slot="signed-out" className="bg-background min-h-dvh">
        {showSafely(
          ctx,
          { shows: signIn.view, value: { reason: code } },
          { mode: "full" },
          "Sign in",
        )}
      </div>
    );
  }
  const href = signInHref(signIn.href);
  const action = typeof signIn.action === "string"
    ? ctx.actions[signIn.action]
    : undefined;
  return (
    <main
      data-slot="signed-out"
      className="bg-background text-foreground grid min-h-dvh place-items-center p-6"
    >
      <EmptyState
        icon={<LockKeyhole />}
        title="You've been signed out"
        action={href
          ? (
            <Button asChild>
              <a href={href}>Sign in again</a>
            </Button>
          )
          : action
          ? (
            <Button type="button" onClick={() => void action({}).result()}>
              Sign in again
            </Button>
          )
          : undefined}
      >
        Your session ended. Sign in again to keep working.
      </EmptyState>
    </main>
  );
}

/**
 * The chat shell: sidebar or icon rail, header, main (a conversation, a
 * Space, or a new conversation) and the resizable right panel. One layout at
 * every width; CSS decides what overlays.
 */
const view: ViewDefinition<unknown, React.ReactNode, BrowserViewContext> =
  defineView<unknown, React.ReactNode, BrowserViewContext>({
    id: "ui.shell",
    shows: "shell",
    renderer: "react",
    modes: ["full"],
    render(_value, ctx) {
      const preferences = shellPreferences(
        ctx.collections.shellPreferences.get("main").value,
      );
      const manage =
        (ctx.resources.shell as Record<string, unknown> | undefined)
          ?.theme !== "host";
      const session = ctx.collections.shellSession?.get("main").value;
      if (session?.state === "revoked") {
        return (
          <>
            {manage && <Theme theme={preferences.theme} />}
            <SignedOut ctx={ctx} code={String(session.code ?? "")} />
          </>
        );
      }
      const nav = shellState(ctx.collections.shell.get("main").value);
      const overlay = ctx.collections.shellOverlay.get("main").value;
      const toasts = ctx.collections.shellToasts.list().value.filter((row) =>
        !row.removed
      ).slice(-4) as Row[];
      const mode = preferences.sidebar;
      const manageTheme =
        (ctx.resources.shell as Record<string, unknown> | undefined)
          ?.theme !== "host";
      const main: ViewReference = nav.page
        ? {
          shows: nav.page,
          value: nav.section ? { section: nav.section } : null,
        }
        : nav.spaceId
        ? {
          shows: "space",
          value: { spaceId: nav.spaceId, threadId: nav.threadId },
        }
        : nav.threadId
        ? { shows: "thread", value: { id: nav.threadId } }
        : {
          shows: "newThread",
          value: nav.newIn ? { spaceId: nav.newIn } : null,
        };
      const panelOpen = nav.panel && Boolean(nav.threadId) && !nav.spaceId &&
        !nav.page;
      const dialog = overlay?.dialog as ViewReference | null | undefined;
      return (
        <TooltipProvider>
          <div
            data-slot="shell"
            data-sidebar={mode}
            className="bg-background text-foreground relative flex h-dvh w-full overflow-hidden"
          >
            {manageTheme && <Theme theme={preferences.theme} />}
            <Shortcuts ctx={ctx} sidebar={mode} panel={nav.panel} />
            <div
              className={cn(
                "relative z-40 h-full shrink-0 transition-[width] duration-200",
                mode === "rail" ? "w-14" : "w-14 lg:w-72",
              )}
            >
              <div
                className={cn(
                  "border-sidebar-border absolute inset-y-0 left-0 overflow-hidden border-r transition-[width,box-shadow] duration-200",
                  mode === "rail" && "w-14",
                  mode === "auto" && "w-14 lg:w-72",
                  mode === "expanded" &&
                    "w-72 max-w-[85vw] shadow-float lg:shadow-none",
                )}
              >
                {ctx.show({
                  shows: "shellSidebar",
                  value: null,
                }) as React.ReactNode}
              </div>
            </div>
            {mode === "expanded" && (
              <button
                type="button"
                aria-label="Collapse sidebar"
                tabIndex={-1}
                onClick={() => ctx.actions.shellPreference({ sidebar: "auto" })}
                className="animate-in fade-in-0 fixed inset-0 z-30 bg-black/30 lg:hidden"
              />
            )}
            <div className="relative flex min-w-0 flex-1 flex-col">
              {ctx.show({
                shows: "shellHeader",
                value: null,
              }) as React.ReactNode}
              <div className="relative flex min-h-0 flex-1 overflow-hidden">
                <main
                  id="shell-main"
                  className="flex min-h-0 min-w-0 flex-1 flex-col"
                >
                  {showSafely(
                    ctx,
                    navReference(main, nav.origin),
                    { mode: "full", embedded: true },
                    "This page",
                  )}
                </main>
                {panelOpen && (ctx.show({
                  shows: "shellPanel",
                  value: { threadId: nav.threadId },
                }) as React.ReactNode)}
              </div>
            </div>
            {ctx.show({
              shows: "shellPalette",
              value: null,
            }) as React.ReactNode}
            {dialog && (
              <Dialog
                open
                onOpenChange={(open) => {
                  if (!open) ctx.actions.shellDialog({ reference: null });
                }}
              >
                <DialogContent className="sm:max-w-xl">
                  <DialogTitle className="sr-only">Dialog</DialogTitle>
                  {showSafely(ctx, dialog, { mode: "dialog" }, "This dialog")}
                </DialogContent>
              </Dialog>
            )}
            <Toaster
              toasts={toasts.map((toast) => ({
                id: toast.id,
                text: String(toast.text ?? ""),
                tone: toast.tone === "error" ? "error" : "info",
              }))}
              onDismiss={(id) => ctx.actions.shellDismissToast({ id })}
            />
          </div>
        </TooltipProvider>
      );
    },
  });

export default view;
