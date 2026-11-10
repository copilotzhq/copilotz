/**
 * The shell's frame: the sidebar beside the main area; on a phone, the
 * sidebar is a drawer (the toolkit's, modal) that the menu button opens.
 * Going anywhere closes it, as do Escape and a tap outside; while it's open,
 * the page behind waits, and focus goes back to the menu button after. A
 * page that offers the side panel has its button at its top right, and the
 * panel beside it (on a phone, a sheet): see panel.tsx.
 *
 * The command palette opens with ⌘K (Ctrl+K elsewhere), or from Search at
 * the top of the sidebar, over whatever page is open; the same key closes
 * it. Besides what front ends list there, the shell offers its own: the
 * side panel, going home, signing out.
 *
 * Where the app serves many orgs, the front end that knows them fills the
 * `orgs` slot (see shared/orgs.ts): the top of the sidebar is its switcher
 * beside the app's mark, its overlay is drawn beside every page, and what
 * its hook lists joins the user menu and the palette. Without it, the top of
 * the sidebar is the app's whole logo.
 */
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Button,
  closePalette,
  Drawer,
  IconButton,
  Kbd,
  Logo,
  NavItem,
  openPalette,
  Palette,
  type PaletteGroup,
  signOut,
} from "../../../../hosts/web/mod.ts";
import type { OrgsShown, OrgsSlot } from "../shared/orgs.ts";
import { apple, opens, type PaletteSource, shortcutOf } from "../shared/palette.ts";
import { toggleLabel } from "../shared/panel.ts";
import type { UserMenuEntry } from "../shared/menu.ts";
import { STYLE } from "../shared/style.ts";
import { Me } from "./me.tsx";
import { say } from "./words.ts";
import { type Offered, PanelSheet, PanelToggle, SidePanel, usePanel } from "./panel.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** The `orgs` slot as drawn: its Views, and its hook. */
export type Orgs = { switcher: ReactNode; overlay?: ReactNode; use?: OrgsSlot["use"] };

/** Where no front end fills the slot: nothing of orgs. */
const none = (): OrgsShown | undefined => undefined;

/** Where the sidebar becomes a drawer (as the style says). */
const PHONE = "(max-width: 760px)";

const phone = {
  subscribe(changed: () => void) {
    const query = matchMedia(PHONE);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  },
  matches: () => matchMedia(PHONE).matches,
};

export function Frame(
  { path, brand, viewer, label, email, sidebar, menu, call, panel, palette, orgs, children }: {
    /** Where the page is: going elsewhere closes the drawer, and the panel's sheet. */
    path: string;
    /** The app's name, which its logo says (or shows). */
    brand: string;
    /** Who's looking: the panel is kept as they left it. */
    viewer: string;
    /** What the viewer is shown as, when not their id (their name). */
    label?: string;
    /** The viewer's email, where the host knows it. */
    email?: string;
    sidebar: ReactNode;
    /** What front ends put in the person's menu (the `userMenu` resource). */
    menu: UserMenuEntry[];
    /** How the shell calls Actions (the person naming themselves; the `orgs` slot's hook). */
    call: Call;
    /** The side panel, when the page offers it. */
    panel?: Offered;
    /** What fills the command palette, and where the person is, for its Views. */
    palette: { sources: PaletteSource[]; hints: Record<string, unknown> };
    /** Where the app serves many orgs: the `orgs` slot, as its front end fills it. */
    orgs?: Orgs;
    children: ReactNode;
  },
): ReactNode {
  // Drawn on a server (a test), it is not a phone.
  const narrow = useSyncExternalStore(phone.subscribe, phone.matches, () => false);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path, narrow]);
  const side = usePanel(viewer, path, narrow);
  const panelId = useId();
  const mac = apple();
  // The app's orgs, as the slot's front end lists them: the same hook on every draw. Until it
  // answers (or where there's one org), the top of the sidebar is the app's whole logo.
  const shown = (orgs?.use ?? none)(call);
  const switcher = shown ? orgs?.switcher : undefined;

  // ⌘K (Ctrl+K) opens the palette over any page, and closes it; not over another dialog.
  // Heard first (capturing), so a field that keeps its keys (a terminal's) doesn't swallow it.
  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (!opens(event, mac) || event.repeat) return;
      const shown = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (shown && !shown.classList.contains("copilotz-palette")) return;
      event.preventDefault();
      event.stopPropagation();
      if (shown) closePalette();
      else openPalette();
    };
    document.addEventListener("keydown", pressed, true);
    return () => document.removeEventListener("keydown", pressed, true);
  }, [mac]);

  const find = () => {
    setOpen(false);
    openPalette();
  };
  const own: PaletteGroup[] = [...(shown?.palette ?? []), {
    title: say("general"),
    order: 90,
    items: [
      ...(panel
        ? [{
          key: "shell:panel",
          label: toggleLabel(side.shown, panel.title),
          icon: "panel" as const,
          keywords: say("keysPanel").split(/\s+/).filter(Boolean),
          run: () => side.toggle(),
        }]
        : []),
      {
        key: "shell:home",
        label: say("goHome"),
        icon: "home",
        href: typeof palette.hints.in === "string"
          ? `/?in=${encodeURIComponent(palette.hints.in)}`
          : "/",
      },
      { key: "shell:signout", label: say("signOut"), icon: "signout", run: () => signOut() },
    ],
  }];

  const content = (
    <>
      <div className="copilotz-sidebar-head" data-orgs={switcher ? "" : undefined}>
        {switcher
          ? (
            <>
              <a
                className="copilotz-brand copilotz-brand-mark"
                href="/"
                title={say("homeOf", { brand })}
              >
                <Logo name={brand} size={24} />
              </a>
              {switcher}
            </>
          )
          : (
            <a className="copilotz-brand" href="/">
              <Logo variant="full" name={brand} size={32} />
            </a>
          )}
        {narrow
          ? <IconButton icon="close" label={say("closeSidebar")} onClick={() => setOpen(false)} />
          : null}
      </div>
      <div className="copilotz-find">
        <NavItem
          quiet
          icon="search"
          onClick={find}
          end={narrow ? null : <Kbd>{shortcutOf(mac)}</Kbd>}
          title={say("searchTitle", { shortcut: shortcutOf(mac) })}
        >
          {say("search")}
        </NavItem>
      </div>
      <nav className="copilotz-sections" aria-label={say("spacesAndChats")}>{sidebar}</nav>
      {viewer
        ? (
          <Me
            {...(label ? { name: label } : {})}
            email={shown?.email ?? email}
            menu={[...menu, ...(shown?.menu ?? [])]}
            call={call}
          />
        )
        : null}
    </>
  );

  return (
    <div className="copilotz-shell">
      <style href="web-shell" precedence="copilotz">{STYLE}</style>
      <Button
        className="copilotz-skip"
        onClick={() => document.getElementById("copilotz-main")?.focus()}
      >
        {say("skipToContent")}
      </Button>
      {narrow
        ? (
          <Drawer
            open={open}
            onClose={() => setOpen(false)}
            label={say("sidebar")}
            className="copilotz-sidebar"
          >
            {content}
          </Drawer>
        )
        : <aside className="copilotz-sidebar" aria-label={say("sidebar")}>{content}</aside>}
      <div className="copilotz-stage">
        <main
          id="copilotz-main"
          className="copilotz-main"
          tabIndex={-1}
          // The panel's button sits over the page's top right while the panel is closed.
          style={panel && (narrow || !side.shown)
            ? { "--copilotz-inset-end": narrow ? "60px" : "54px" } as CSSProperties
            : undefined}
        >
          {narrow
            ? (
              <IconButton
                icon="menu"
                label={say("openSidebar")}
                size="lg"
                className="copilotz-shell-menu"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(true)}
              />
            )
            : null}
          {children}
        </main>
        {panel && !narrow && side.shown
          ? <SidePanel panel={panel} state={side} id={panelId} />
          : null}
        {/* At the top right, open or not: the button never moves. */}
        {panel ? <PanelToggle panel={panel} state={side} id={panelId} narrow={narrow} /> : null}
      </div>
      {panel && narrow ? <PanelSheet panel={panel} state={side} id={panelId} /> : null}
      <Palette sources={palette.sources} hints={palette.hints} own={own} />
      {orgs?.overlay ?? null}
    </div>
  );
}
