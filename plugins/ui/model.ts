/**
 * Framework-free shell model: navigation state, the URL codec and history,
 * conversation grouping by Space or recency, the section registry and the
 * touch gesture that moves a conversation into a Space.
 * @module
 */
import {
  recencyGroup,
  type RecencyLabels,
  type Row,
  type StorageAdapter,
} from "@copilotz/copilotz/web";

/** Where the reader is: a conversation, a Space, a section, the panel. */
export type ShellState = Readonly<{
  /** The open conversation. */
  threadId: string | null;
  /** The Space shown in the main area, over the conversation. */
  spaceId: string | null;
  /** The selected Space section, shared by the main area and the panel. */
  section: string | null;
  /** The right panel beside the conversation. */
  panel: boolean;
  /** A new conversation's Space (the new-conversation screen). */
  newIn: string | null;
  /** `url` while the state came from a link; any in-app navigation is `app`. */
  origin: "app" | "url";
}>;

export const initialShell: ShellState = {
  threadId: null,
  spaceId: null,
  section: null,
  panel: false,
  newIn: null,
  origin: "app",
};

const id = (value: unknown): string | null =>
  typeof value === "string" && /^[\w.:@~-]{1,200}$/.test(value) ? value : null;

/** Normalize any row or patch into a complete, identifier-only state. */
export function shellState(value: unknown): ShellState {
  const row = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    threadId: id(row.threadId),
    spaceId: id(row.spaceId),
    section: id(row.section),
    panel: row.panel === true,
    newIn: id(row.newIn),
    origin: row.origin === "url" ? "url" : "app",
  };
}

/** Maps shell state to and from a URL; it must keep unrelated parameters. */
export interface ShellUrlCodec {
  decode(url: URL): Omit<ShellState, "origin"> | undefined;
  encode(url: URL, state: ShellState): void;
}

/** `?chat=<id>&space=<id>&section=<id>&panel=1&new=<spaceId|1>`. */
export const defaultShellCodec: ShellUrlCodec = {
  decode(url) {
    const query = url.searchParams;
    const fresh = query.get("new");
    return shellState({
      threadId: query.get("chat"),
      spaceId: query.get("space"),
      section: query.get("section"),
      panel: query.get("panel") === "1",
      newIn: fresh && fresh !== "1" ? fresh : null,
    });
  },
  encode(url, state) {
    const query = url.searchParams;
    const put = (key: string, value: string | null) =>
      value ? query.set(key, value) : query.delete(key);
    put("chat", state.threadId);
    put("space", state.spaceId);
    put("section", state.section);
    put("panel", state.panel ? "1" : null);
    put(
      "new",
      !state.threadId && !state.spaceId && state.newIn ? state.newIn : null,
    );
  },
};

/** The page history the shell reads and writes (a host capability). */
export interface ShellHistory {
  read(): URL;
  /** `push` adds an entry Back returns to; `replace` updates this one. */
  write(url: URL, mode: "push" | "replace"): void;
  /** Whether the current entry was written by the app, not opened from a link. */
  own?(): boolean;
  /** Fires `popstate` on Back and Forward. */
  events?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

type BrowserWindow = {
  location: { href: string };
  history: {
    state: unknown;
    pushState(state: unknown, unused: string, url: string): void;
    replaceState(state: unknown, unused: string, url: string): void;
  };
} & Pick<EventTarget, "addEventListener" | "removeEventListener">;

const OWN = "copilotzShell";

/** The page's own history, marking the entries the app writes. */
export function browserShellHistory(window: BrowserWindow): ShellHistory {
  return {
    read: () => new URL(window.location.href),
    write(url, mode) {
      const state = { [OWN]: true };
      if (mode === "push") window.history.pushState(state, "", url.href);
      else window.history.replaceState(state, "", url.href);
    },
    own: () =>
      Boolean(
        (window.history.state as Record<string, unknown> | null)?.[OWN],
      ),
    events: window,
  };
}

/**
 * URL storage for the `shell` Collection. Identifiers only; a conversation or
 * Space change adds a history entry, anything else replaces the current one.
 * State restored from a link is marked `origin: "url"`, so the shell renders
 * it only with Views that declare `url` and holds their query reads.
 */
export function shellUrlStorageAdapter(
  history: ShellHistory,
  codec: ShellUrlCodec = defaultShellCodec,
): StorageAdapter {
  let last: ShellState | undefined;
  return {
    ...(history.events
      ? {
        subscribe(listener: () => void) {
          history.events!.addEventListener("popstate", listener);
          return () =>
            history.events!.removeEventListener("popstate", listener);
        },
      }
      : {}),
    load() {
      const decoded = codec.decode(new URL(history.read()));
      if (!decoded) return undefined;
      const state = shellState({
        ...decoded,
        origin: history.own?.() ? "app" : "url",
      });
      last = state;
      return [{ id: "main", ...state }];
    },
    save(_key, rows) {
      const state = shellState(rows.find((row) => row.id === "main"));
      const url = new URL(history.read());
      codec.encode(url, state);
      const moved = !last || last.threadId !== state.threadId ||
        last.spaceId !== state.spaceId || last.newIn !== state.newIn;
      last = state;
      if (url.href === history.read().href && !moved) return;
      history.write(url, moved ? "push" : "replace");
    },
  };
}

/** Per-device preferences, kept in local storage by the host. */
export type ShellPreferences = Readonly<{
  /** `auto` is expanded from `lg` up and the icon rail below it. */
  sidebar: "auto" | "expanded" | "rail";
  groupBy: "space" | "date";
  panelWidth: number;
  theme: "light" | "dark" | "system";
  archived: boolean;
  /** Spaces whose conversations the reader expanded or collapsed. */
  expanded: readonly string[];
  collapsed: readonly string[];
}>;

export const defaultPreferences: ShellPreferences = {
  sidebar: "auto",
  groupBy: "space",
  panelWidth: 420,
  theme: "system",
  archived: false,
  expanded: [],
  collapsed: [],
};

export function shellPreferences(value: unknown): ShellPreferences {
  const row = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const list = (field: unknown) =>
    Array.isArray(field)
      ? field.filter((item): item is string => typeof item === "string")
      : [];
  const width = Number(row.panelWidth);
  return {
    sidebar: row.sidebar === "expanded" || row.sidebar === "rail"
      ? row.sidebar
      : "auto",
    groupBy: row.groupBy === "date" ? "date" : "space",
    panelWidth: Number.isFinite(width) && width >= 240 ? width : 420,
    theme: row.theme === "light" || row.theme === "dark" ? row.theme : "system",
    archived: row.archived === true,
    expanded: list(row.expanded),
    collapsed: list(row.collapsed),
  };
}

/** Whether the page should be dark for a preference and the system setting. */
export function resolveDarkMode(
  theme: ShellPreferences["theme"],
  systemPrefersDark: boolean,
): boolean {
  return theme === "dark" || (theme === "system" && systemPrefersDark);
}

/** The panel width the layout can honor: at least 280, leaving room for main. */
export function clampPanelWidth(width: number, available: number): number {
  const max = Math.max(280, available);
  return Math.round(Math.min(Math.max(width, 280), max));
}

export type ThreadGroup = Readonly<{
  key: string;
  label: string;
  /** The Space, for Space groups (null for "No Space"). */
  spaceId: string | null;
  space?: Row;
  /** An archived or unreadable Space still holding conversations. */
  unavailable?: boolean;
  threads: readonly Row[];
}>;

/**
 * Every conversation in exactly one Space bucket, Spaces in order, then any
 * archived or unreadable Spaces that still hold conversations, then "No
 * Space". Only a conversation without a Space belongs to No Space.
 */
export function groupThreadsBySpace(
  threads: readonly Row[],
  spaces: readonly Row[],
  noSpaceLabel = "No Space",
): ThreadGroup[] {
  type Group = {
    key: string;
    label: string;
    spaceId: string | null;
    space?: Row;
    unavailable?: boolean;
    threads: Row[];
  };
  const groups: Group[] = [];
  const unavailable = new Map<string, Group>();
  const bySpace = new Map<string, Group>();
  for (const space of spaces) {
    const name = String(space.name ?? "") || space.id;
    const archived = space.status === "archived";
    const group: Group = {
      key: archived ? `space:archived:${space.id}` : `space:${space.id}`,
      label: archived ? `${name} (Archived)` : name,
      spaceId: space.id,
      space,
      ...(archived ? { unavailable: true } : {}),
      threads: [],
    };
    bySpace.set(space.id, group);
    if (!archived) groups.push(group);
  }
  const none: Row[] = [];
  for (const thread of threads) {
    const spaceId = typeof thread.spaceId === "string" ? thread.spaceId : "";
    if (!spaceId) {
      none.push(thread);
      continue;
    }
    let group = bySpace.get(spaceId);
    if (!group) {
      group = {
        key: `space:unavailable:${spaceId}`,
        label: "Unavailable Space",
        spaceId,
        unavailable: true,
        threads: [],
      };
      bySpace.set(spaceId, group);
    }
    if (group.unavailable && !unavailable.has(group.key)) {
      unavailable.set(group.key, group);
    }
    group.threads.push(thread);
  }
  groups.push(...unavailable.values());
  if (none.length) {
    groups.push({
      key: "space:none",
      label: noSpaceLabel,
      spaceId: null,
      threads: none,
    });
  }
  return groups;
}

/** Conversations by recency: Today, Yesterday, Previous 7 and 30 days, months. */
export function groupThreadsByRecency(
  threads: readonly Row[],
  options: { now?: number; locale?: string; labels?: RecencyLabels } = {},
): ThreadGroup[] {
  const groups = new Map<string, { label: string; threads: Row[] }>();
  for (const thread of threads) {
    const group = recencyGroup(
      String(thread.updatedAt ?? thread.createdAt ?? ""),
      options,
    );
    const entry = groups.get(group.key) ??
      { label: group.label, threads: [] };
    entry.threads.push(thread);
    groups.set(group.key, entry);
  }
  return [...groups.entries()].sort(([left], [right]) =>
    left < right ? 1 : left > right ? -1 : 0
  ).map(([key, value]) => ({
    key: `date:${key}`,
    label: value.label,
    spaceId: null,
    threads: value.threads,
  }));
}

/** A Space section an app or the shell registers in `resources.spaceSections`. */
export type SpaceSection = Readonly<{
  id: string;
  label: string;
  icon?: string;
  order: number;
  /** The View kind; it receives `{ spaceId, threadId }`. */
  view: string;
  /** Tool ids whose use marks this section's tab with a dot. */
  tools: readonly string[];
}>;

/** The registered sections in order (by `order`, then label). */
export function spaceSections(resources: unknown): SpaceSection[] {
  const registered = resources && typeof resources === "object"
    ? resources as Record<string, unknown>
    : {};
  return Object.entries(registered).flatMap(([id, value]) => {
    const entry = value && typeof value === "object"
      ? value as Record<string, unknown>
      : undefined;
    if (!entry || typeof entry.view !== "string") return [];
    return [{
      id,
      label: typeof entry.label === "string" ? entry.label : id,
      ...(typeof entry.icon === "string" ? { icon: entry.icon } : {}),
      order: typeof entry.order === "number" ? entry.order : 50,
      view: entry.view,
      tools: Array.isArray(entry.tools)
        ? entry.tools.filter((tool): tool is string => typeof tool === "string")
        : [],
    }];
  }).sort((left, right) =>
    left.order - right.order || left.label.localeCompare(right.label)
  );
}

/** A header or user menu item an app registers (`resources.headerMenu.<id>`). */
export type MenuItem = Readonly<{
  id: string;
  label: string;
  icon?: string;
  order: number;
  /** A composed Action alias, called with `{ threadId, spaceId }`. */
  action?: string;
  /** A View kind opened in the shell's dialog host. */
  dialog?: string;
  destructive: boolean;
  /** Shown only while a conversation (or a Space) is open. */
  requires?: "thread" | "space";
}>;

export function menuItems(resources: unknown): MenuItem[] {
  const registered = resources && typeof resources === "object"
    ? resources as Record<string, unknown>
    : {};
  return Object.entries(registered).flatMap(([id, value]) => {
    const entry = value && typeof value === "object"
      ? value as Record<string, unknown>
      : undefined;
    if (
      !entry || typeof entry.label !== "string" ||
      (typeof entry.action !== "string" && typeof entry.dialog !== "string")
    ) return [];
    return [{
      id,
      label: entry.label,
      ...(typeof entry.icon === "string" ? { icon: entry.icon } : {}),
      order: typeof entry.order === "number" ? entry.order : 50,
      ...(typeof entry.action === "string" ? { action: entry.action } : {}),
      ...(typeof entry.dialog === "string" ? { dialog: entry.dialog } : {}),
      destructive: entry.destructive === true,
      ...(entry.requires === "thread" || entry.requires === "space"
        ? { requires: entry.requires as "thread" | "space" }
        : {}),
    }];
  }).sort((left, right) =>
    left.order - right.order || left.label.localeCompare(right.label)
  );
}

export type TouchSpaceDragSession = {
  pointerId: number;
  threadId: string;
  originalSpaceId: string | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
};

/** One gesture, consumed synchronously before any asynchronous move. */
export class TouchSpaceDrag {
  session: TouchSpaceDragSession | null = null;

  start(
    pointerId: number,
    threadId: string,
    originalSpaceId: string | null,
    x: number,
    y: number,
  ): boolean {
    if (this.session) return false;
    this.session = {
      pointerId,
      threadId,
      originalSpaceId,
      startX: x,
      startY: y,
      x,
      y,
      active: false,
    };
    return true;
  }

  update(pointerId: number, x: number, y: number): boolean {
    const session = this.session;
    if (!session || pointerId !== session.pointerId) return false;
    session.x = x;
    session.y = y;
    if (Math.hypot(x - session.startX, y - session.startY) >= 6) {
      session.active = true;
    }
    return session.active;
  }

  release(
    pointerId: number,
    spaceId: string | null,
    eligibleIds: readonly string[],
  ): { threadId: string; spaceId: string } | null {
    const session = this.session;
    if (!session || session.pointerId !== pointerId) return null;
    this.session = null;
    if (
      !session.active || !spaceId || spaceId === session.originalSpaceId ||
      !eligibleIds.includes(spaceId)
    ) return null;
    return { threadId: session.threadId, spaceId };
  }

  cancel(): void {
    this.session = null;
  }
}

/** Pixels per second; outside the destination viewport never scrolls. */
export function spaceDragScrollSpeed(
  x: number,
  y: number,
  rect: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    height: number;
  },
): number {
  if (
    x < rect.left || x > rect.right || y < rect.top || y > rect.bottom ||
    rect.height <= 0
  ) return 0;
  const edge = Math.min(44, rect.height / 3);
  if (y < rect.top + edge) return -480 * (1 - (y - rect.top) / edge);
  if (y > rect.bottom - edge) return 480 * (1 - (rect.bottom - y) / edge);
  return 0;
}
