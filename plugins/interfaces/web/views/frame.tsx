/// <reference lib="dom" />
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
 * Where the app serves many orgs (see orgs.tsx), the top of the sidebar is
 * the org switcher beside the app's mark, the foot is the user menu, and
 * the palette lists orgs too; in an org as staff, a line in the warning
 * colour runs along the top of the window, all the time.
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
  asStaff,
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
  useOrgs,
} from "../../../../hosts/web/mod.ts";
import { apple, opens, type PaletteSource, shortcutOf } from "../shared/palette.ts";
import { toggleLabel } from "../shared/panel.ts";
import type { UserMenuEntry } from "../shared/menu.ts";
import { useStanding } from "../shared/standing.ts";
import { STYLE } from "../shared/style.ts";
import { Me } from "./me.tsx";
import { NewOrg, orgsPalette, OrgSwitcher, Switching } from "./orgs.tsx";
import { type Offered, PanelSheet, PanelToggle, SidePanel, usePanel } from "./panel.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

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
  { path, brand, viewer, sidebar, menu, call, panel, palette, children }: {
    /** Where the page is: going elsewhere closes the drawer, and the panel's sheet. */
    path: string;
    /** The app's name, which its logo says (or shows). */
    brand: string;
    /** Who's looking: the panel is kept as they left it. */
    viewer: string;
    sidebar: ReactNode;
    /** What front ends put in the person's menu (the `userMenu` resource). */
    menu: UserMenuEntry[];
    /** How the shell calls Actions (the person's standing in their org: `org.me`). */
    call: Call;
    /** The side panel, when the page offers it. */
    panel?: Offered;
    /** What fills the command palette, and where the person is, for its Views. */
    palette: { sources: PaletteSource[]; hints: Record<string, unknown> };
    children: ReactNode;
  },
): ReactNode {
  const narrow = useSyncExternalStore(phone.subscribe, phone.matches);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path, narrow]);
  const side = usePanel(viewer, path, narrow);
  const panelId = useId();
  const mac = apple();
  const orgsState = useOrgs();
  const orgs = orgsState.status === "ready" ? orgsState.value : undefined;
  const here = orgsState.status === "ready" ? orgsState.here : undefined;
  const staff = orgs ? asStaff(orgs) : false;
  const standing = useStanding(call, !!orgs);
  const [making, setMaking] = useState(false);

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
  const own: PaletteGroup[] = [...(orgs ? orgsPalette(orgs, here, standing) : []), {
    title: "General",
    order: 90,
    items: [
      ...(panel
        ? [{
          key: "shell:panel",
          label: toggleLabel(side.shown, panel.title),
          icon: "panel" as const,
          keywords: ["side panel", "toggle"],
          run: () => side.toggle(),
        }]
        : []),
      {
        key: "shell:home",
        label: "Go home",
        icon: "home",
        href: typeof palette.hints.in === "string"
          ? `/?in=${encodeURIComponent(palette.hints.in)}`
          : "/",
      },
      { key: "shell:signout", label: "Sign out", icon: "signout", run: () => signOut() },
    ],
  }];

  const content = (
    <>
      <div className="copilotz-sidebar-head" data-orgs={orgs ? "" : undefined}>
        {orgs
          ? (
            <>
              <a className="copilotz-brand copilotz-brand-mark" href="/" title={`${brand}: home`}>
                <Logo name={brand} size={24} />
              </a>
              <OrgSwitcher
                orgs={orgs}
                here={here}
                standing={standing}
                staff={staff}
                onNew={() => {
                  setOpen(false);
                  setMaking(true);
                }}
              />
            </>
          )
          : (
            <a className="copilotz-brand" href="/">
              <Logo variant="full" name={brand} size={32} />
            </a>
          )}
        {narrow
          ? <IconButton icon="close" label="Close sidebar" onClick={() => setOpen(false)} />
          : null}
      </div>
      <div className="copilotz-find">
        <NavItem
          quiet
          icon="search"
          onClick={find}
          end={narrow ? null : <Kbd>{shortcutOf(mac)}</Kbd>}
          title={`Search spaces and chats, or run a command (${shortcutOf(mac)})`}
        >
          Search
        </NavItem>
      </div>
      <nav className="copilotz-sections" aria-label="Spaces and chats">{sidebar}</nav>
      {viewer
        ? (
          <Me
            name={viewer}
            email={orgs?.email}
            menu={menu}
            {...(orgs ? { orgs: { here: !!here, standing, staff: orgs.staff } } : {})}
          />
        )
        : null}
    </>
  );

  return (
    <div className="copilotz-shell" data-staff={staff || undefined}>
      <style href="web-shell" precedence="copilotz">{STYLE}</style>
      {staff
        ? (
          <div className="copilotz-staff-line" role="note">
            <span className="copilotz-sr">
              You're in this org as platform staff: what you do is on its record.
            </span>
          </div>
        )
        : null}
      <Button
        className="copilotz-skip"
        onClick={() => document.getElementById("copilotz-main")?.focus()}
      >
        Skip to content
      </Button>
      {narrow
        ? (
          <Drawer
            open={open}
            onClose={() => setOpen(false)}
            label="Sidebar"
            className="copilotz-sidebar"
          >
            {content}
          </Drawer>
        )
        : <aside className="copilotz-sidebar" aria-label="Sidebar">{content}</aside>}
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
                label="Open sidebar"
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
      {orgs ? <NewOrg open={making} onClose={() => setMaking(false)} /> : null}
      <Switching />
    </div>
  );
}
