/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect, useRef, useState } from "react";
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
  dom,
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

/** Phones: the sidebar is a drawer and the side panel a full-screen sheet. */
export const PHONE_QUERY = "(max-width: 767px)";
export const phone = (): boolean => mediaMatches(PHONE_QUERY);

/** Whether a media query matches, following changes. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query));
  useEffect(() => {
    let media: ReturnType<NonNullable<typeof browser.matchMedia>> | undefined;
    try {
      media = browser.matchMedia?.(query);
    } catch {
      return;
    }
    if (!media) return;
    const update = () => setMatches(media!.matches);
    update();
    media.addEventListener("change", update);
    return () => media!.removeEventListener("change", update);
  }, [query]);
  return matches;
}

type FocusTarget = {
  focus(options?: { preventScroll?: boolean }): void;
  isConnected?: boolean;
};
const activeElement = (): FocusTarget | null =>
  ((browser.document as { activeElement?: FocusTarget } | undefined)
    ?.activeElement) ?? null;
/** Focus back where it was, if that element is still on the page. */
const restore = (target: FocusTarget | null) => {
  if (target && target.isConnected !== false) {
    target.focus({ preventScroll: true });
  }
};

/**
 * ⌘K search, ⌘B sidebar (the drawer on phones), ⌘. panel. Escape closes the
 * phone drawer, then an overlaying panel or sidebar.
 */
function Shortcuts(
  { ctx, sidebar, panel, drawer }: {
    ctx: BrowserViewContext;
    sidebar: "auto" | "expanded" | "rail";
    panel: boolean;
    drawer: boolean;
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
        if (phone()) ctx.actions.shellOverlay({ drawer: !drawer });
        else ctx.actions.shellPreference({ sidebar: nextSidebar(sidebar) });
      } else if (mod && event.key === ".") {
        event.preventDefault();
        ctx.actions.shellPanel({ open: !panel });
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        // A dialog or menu over the drawer handles its own Escape first.
        if (drawer) {
          event.preventDefault();
          ctx.actions.shellOverlay({ drawer: false });
          return;
        }
        if (wide()) return;
        const open = browser.document?.querySelector('[role="dialog"]');
        if (open) return;
        if (panel) ctx.actions.shellPanel({ open: false });
        else if (sidebar === "expanded" && !phone()) {
          ctx.actions.shellPreference({ sidebar: "auto" });
        }
      }
    };
    browser.addEventListener("keydown", handler);
    return () => browser.removeEventListener("keydown", handler);
  }, [sidebar, panel, drawer]);
  return null;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside a container: the last stop wraps to the first. */
function trapTab(container: unknown, event: React.KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const items = Array.from(dom(container).querySelectorAll(FOCUSABLE)).filter(
    (item) =>
      (item as unknown as { getClientRects(): ArrayLike<unknown> })
        .getClientRects().length > 0,
  );
  if (!items.length) return;
  const current = activeElement();
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && (current === first || current === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && current === last) {
    event.preventDefault();
    first.focus();
  }
}

/** A drag this far (or a quick flick) closes the drawer. */
const SWIPE_CLOSE = 0.3;

/**
 * The sidebar's place: the rail or the expanded sidebar from `md` up, and an
 * off-canvas drawer on phones. The drawer is modal while open: focus moves in
 * and stays (the rest is inert), and Escape, the backdrop, a swipe to the
 * left or picking a chat closes it.
 */
function SidebarFrame(
  { mode, drawer, onCloseDrawer, onCollapse, children }: {
    mode: "auto" | "expanded" | "rail";
    drawer: boolean;
    onCloseDrawer(): void;
    onCollapse(): void;
    children: React.ReactNode;
  },
): React.ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  const swipe = useRef<
    { id: number; x: number; y: number; at: number; active: boolean } | null
  >(null);
  const [offset, setOffset] = useState(0);
  const isPhone = useMedia(PHONE_QUERY);
  const modal = drawer && isPhone;
  // Focus moves into the drawer (visible as soon as it opens) and returns
  // where it was.
  useEffect(() => {
    if (!modal) return;
    const previous = activeElement();
    if (panel.current) dom(panel.current).focus({ preventScroll: true });
    return () => restore(previous);
  }, [modal]);
  // Growing past phone width leaves no drawer behind.
  useEffect(() => {
    if (drawer && !isPhone) onCloseDrawer();
  }, [drawer, isPhone]);
  const width = () => panel.current ? dom(panel.current).clientWidth || 1 : 1;
  const endSwipe = (close: boolean) => {
    swipe.current = null;
    // Closing keeps the dragged position until the drawer slides away from it.
    if (close) onCloseDrawer();
    else setOffset(0);
  };
  useEffect(() => {
    if (!drawer) setOffset(0);
  }, [drawer]);
  return (
    <>
      <div
        className={cn(
          // On phones it holds the drawer, above the drawer's backdrop.
          "relative z-40 h-full shrink-0 transition-[width] duration-200 max-md:z-50 max-md:w-0",
          mode === "rail" ? "w-14" : "w-14 lg:w-72",
        )}
      >
        <div
          ref={panel}
          id="shell-sidebar"
          data-slot="shell-drawer"
          data-state={drawer ? "open" : "closed"}
          // A dialog only while it overlays the page on a phone.
          role={modal ? "dialog" : undefined}
          aria-modal={modal || undefined}
          aria-label={modal ? "Navigation" : undefined}
          tabIndex={modal ? -1 : undefined}
          onKeyDown={modal
            ? (event) => trapTab(panel.current, event)
            : undefined}
          onPointerDown={(event) => {
            if (!modal || event.pointerType !== "touch" || !event.isPrimary) {
              return;
            }
            // The handle that drags a chat into a Space keeps its gesture.
            if (dom(event.target).closest("[data-no-swipe]")) return;
            swipe.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              at: Date.now(),
              active: false,
            };
          }}
          onPointerMove={(event) => {
            const gesture = swipe.current;
            if (!gesture || gesture.id !== event.pointerId) return;
            const dx = event.clientX - gesture.x;
            const dy = event.clientY - gesture.y;
            if (!gesture.active) {
              if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
                swipe.current = null; // A scroll, not a swipe.
                return;
              }
              if (dx > -10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
              gesture.active = true;
            }
            setOffset(Math.min(0, dx));
          }}
          onPointerUp={(event) => {
            const gesture = swipe.current;
            if (!gesture || gesture.id !== event.pointerId) return;
            if (!gesture.active) {
              swipe.current = null;
              return;
            }
            const dx = event.clientX - gesture.x;
            const speed = dx / Math.max(1, Date.now() - gesture.at);
            endSwipe(dx < -width() * SWIPE_CLOSE || speed < -0.5);
          }}
          onPointerCancel={() => swipe.current && endSwipe(false)}
          style={drawer && offset
            ? { translate: `${offset}px 0`, transition: "none" }
            : undefined}
          className={cn(
            "border-sidebar-border absolute inset-y-0 left-0 overflow-hidden border-r outline-none transition-[width,box-shadow] duration-200",
            mode === "rail" && "w-14",
            mode === "auto" && "w-14 lg:w-72",
            mode === "expanded" &&
              "w-72 max-w-[85vw] shadow-float lg:shadow-none",
            // Phones: an off-canvas drawer above everything but dialogs.
            "max-md:fixed max-md:z-50 max-md:w-[min(20rem,calc(100vw-3.5rem))] max-md:max-w-none max-md:touch-pan-y max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:duration-300 max-md:ease-[cubic-bezier(0.32,0.72,0,1)]",
            // Visible at once when opening (so focus can move in), and only
            // hidden once it has slid away when closing.
            drawer
              ? "max-md:shadow-float max-md:visible max-md:translate-x-0 max-md:transition-[translate,box-shadow]"
              : "max-md:invisible max-md:-translate-x-full max-md:shadow-none max-md:transition-[translate,visibility,box-shadow]",
          )}
        >
          {children}
        </div>
      </div>
      {mode === "expanded" && (
        <button
          type="button"
          aria-label="Collapse sidebar"
          tabIndex={-1}
          onClick={onCollapse}
          className="animate-in fade-in-0 fixed inset-0 z-30 bg-black/30 max-md:hidden lg:hidden"
        />
      )}
      {drawer && (
        <div
          aria-hidden="true"
          data-slot="shell-drawer-backdrop"
          onClick={onCloseDrawer}
          style={offset
            ? { opacity: Math.max(0, 1 + offset / width()) }
            : undefined}
          className="animate-in fade-in-0 fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] duration-300 md:hidden"
        />
      )}
    </>
  );
}

/**
 * The page beside the sidebar: the header, main and the side panel. On a
 * phone, whatever overlays it (the drawer, or the side panel as a
 * full-screen sheet) makes the rest inert, and the sheet takes focus while
 * open.
 */
function MainFrame(
  { drawer, header, main, panel }: {
    drawer: boolean;
    header: React.ReactNode;
    main: React.ReactNode;
    /** The side panel, when open. */
    panel?: React.ReactNode;
  },
): React.ReactElement {
  const isPhone = useMedia(PHONE_QUERY);
  const column = useRef<HTMLDivElement>(null);
  const covered = isPhone && Boolean(panel);
  useEffect(() => {
    if (!covered) return;
    const previous = activeElement();
    const target = column.current &&
      dom(column.current).querySelector('[data-slot="side-panel"]');
    target?.focus({ preventScroll: true });
    return () => restore(previous);
  }, [covered]);
  return (
    <div
      ref={column}
      inert={(isPhone && drawer) || undefined}
      className="relative flex min-w-0 flex-1 flex-col"
    >
      <div inert={covered || undefined} className="relative z-20 shrink-0">
        {header}
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <main
          id="shell-main"
          inert={covered || undefined}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {main}
        </main>
        {panel}
      </div>
    </div>
  );
}

/**
 * Toggle between the expanded sidebar and the icon rail at the current
 * width. (Phones use the drawer instead, see `shellOverlay.drawer`.)
 */
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
      // The phone drawer is open (memory only: a reload starts closed).
      const drawer = overlay?.drawer === true;
      const dialog = overlay?.dialog as ViewReference | null | undefined;
      return (
        <TooltipProvider>
          <div
            data-slot="shell"
            data-sidebar={mode}
            className="bg-background text-foreground relative flex h-dvh w-full overflow-hidden"
          >
            {manageTheme && <Theme theme={preferences.theme} />}
            <Shortcuts
              ctx={ctx}
              sidebar={mode}
              panel={nav.panel}
              drawer={drawer}
            />
            <SidebarFrame
              mode={mode}
              drawer={drawer}
              onCloseDrawer={() => ctx.actions.shellOverlay({ drawer: false })}
              onCollapse={() =>
                ctx.actions.shellPreference({ sidebar: "auto" })}
            >
              {ctx.show({
                shows: "shellSidebar",
                value: null,
              }) as React.ReactNode}
            </SidebarFrame>
            <MainFrame
              drawer={drawer}
              header={ctx.show({
                shows: "shellHeader",
                value: null,
              }) as React.ReactNode}
              main={showSafely(
                ctx,
                navReference(main, nav.origin),
                { mode: "full", embedded: true },
                "This page",
              )}
              panel={panelOpen
                ? ctx.show({
                  shows: "shellPanel",
                  value: { threadId: nav.threadId },
                }) as React.ReactNode
                : undefined}
            />
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
