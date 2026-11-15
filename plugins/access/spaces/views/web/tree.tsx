/**
 * The spaces in the sidebar, as a tree: each space a link to its page, the
 * one you're in tinted (on its page, raised), and a fold at its end that
 * shows what's under it (the `spaceSidebar` resource's Views: its latest
 * chats), read only once it's unfolded. Where you work starts unfolded; what
 * the person folds or unfolds, this browser keeps. Archived spaces come
 * last, apart, under an Archived fold that starts folded (unless you're in
 * one), quieter, each a link to its page. For an org's owners and admins,
 * the org's other spaces (that they reach by running it, not by being in
 * them) are apart too, under "Across the org", folded the same way. Its
 * guests, who work only in the spaces they're invited to, make none.
 *
 * On the rail, the sidebar folded (`SpaceRail`): the same spaces in use, each
 * its face, a link to its page named beside it, marked the same way.
 */
import { type ReactNode, useId, useState } from "react";
import {
  Avatar,
  Icon,
  IconButton,
  keep,
  kept,
  LazyView,
  NavItem,
  RailItem,
} from "../../../../../hosts/web/mod.ts";
import { useStanding } from "../../../../interfaces/web/contract.ts";
import type { Member, Reached, SpaceSidebar } from "../../contract.ts";
import { nameOf } from "../../shared/names.ts";
import { ORG } from "../../shared/reach.ts";
import { NewSpace } from "./new-space.tsx";
import { spacePath } from "./tabs.ts";
import { listed, spaceName, theirsAlone } from "./who.ts";
import { say } from "./words.ts";

type Folds = Record<string, boolean>;
type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Where no one asks (a test's tree): no standing. */
const noCall: Call = () => Promise.reject(new Error("no call"));

const foldsOf = (key: string): Folds => {
  try {
    const found = JSON.parse(kept(key) ?? "{}");
    return found && typeof found === "object" ? found as Folds : {};
  } catch {
    return {};
  }
};

/** The Archived fold's key among the folds kept, and the org's other spaces'. */
const ARCHIVED = "copilotz:archived";
const ACROSS = "copilotz:across";

/**
 * The person's standing in the org, as the tree lists spaces by it: whether they run it (its
 * owners and admins, and platform staff, reach every space in it), and whether they're its guest.
 */
function useRunning(joined: Member[], call?: Call) {
  const standing = useStanding(call ?? noCall, !!call);
  const role = joined.find((m) => m.space === ORG)?.role;
  // In the org as platform staff (an app serving many orgs gives their sessions that).
  const staff = standing?.staff === true;
  // Where there are orgs (`org.me` names the org), everyone in one but its guests reads their own
  // role there.
  return {
    runs: role === "owner" || role === "admin" || staff,
    guest: !!standing?.org && !staff && !role,
  };
}

/**
 * Whether a space is the person's own, as the tree lists it: any they reach; for those who run
 * the org, those they're in and their Personal (the rest of the org's are apart).
 */
const ownOf = (joined: Member[], viewer: string, runs: boolean) => {
  const theirs = new Set(joined.map((m) => m.space));
  return (s: Reached) =>
    !runs || theirs.has(s._id) || (s.kind === "personal" && s.owner === viewer);
};

export function SpaceTree(
  {
    spaces: reached,
    archived: shelved,
    joined = [],
    here,
    path,
    under,
    viewer,
    names,
    create,
    call,
  }: {
    spaces: Reached[];
    /** Those archived, listed apart. */
    archived: Reached[];
    /** The person's own memberships (their org role among them). */
    joined?: Member[];
    /** Where the person works. */
    here?: string;
    /** The address open. */
    path?: string;
    /** What a space shows under it, unfolded. */
    under: SpaceSidebar[];
    viewer: string;
    /** Whose other people's Personal spaces are, by name (`namesIn`). */
    names: Record<string, string>;
    create(name: string): Promise<void>;
    /** How it asks the person's standing in the org (`org.me`): staff, and whether there are orgs. */
    call?: Call;
  },
): ReactNode {
  // Those who run the org (and staff) reach every space in it: the ones they're in show as
  // anyone's do; the rest of the org's, apart.
  const { runs, guest } = useRunning(joined, call);
  const mine = ownOf(joined, viewer, runs);
  const spaces = reached.filter(mine);
  const archived = shelved.filter(mine);
  const across = [...reached, ...shelved].filter((s) => !mine(s));
  const key = `copilotz-spaces-open:${viewer}`;
  const [folds, setFolds] = useState(() => foldsOf(key));
  const fold = (space: string, open: boolean) => {
    const next = { ...folds, [space]: open };
    setFolds(next);
    keep(key, JSON.stringify(next));
  };
  return (
    <ul className="spaces">
      {spaces.map((s) => (
        <SpaceRow
          key={s._id}
          space={s}
          viewer={viewer}
          names={names}
          here={s._id === here}
          page={path === spacePath(s._id)}
          open={folds[s._id] ?? s._id === here}
          fold={(open) => fold(s._id, open)}
          under={under}
          path={path}
        />
      ))}
      {guest ? null : (
        <li>
          <NewSpace create={create} />
        </li>
      )}
      {across.length
        ? (
          <Apart
            title={say("acrossOrg")}
            icon="building"
            hint={say("acrossOrgHint")}
            spaces={across}
            open={folds[ACROSS] ?? across.some((s) => s._id === here)}
            fold={(open) => fold(ACROSS, open)}
            here={here}
            path={path}
            viewer={viewer}
            names={names}
          />
        )
        : null}
      {archived.length
        ? (
          <Apart
            title={say("archived")}
            icon="archive"
            spaces={archived}
            open={folds[ARCHIVED] ?? archived.some((s) => s._id === here)}
            fold={(open) => fold(ARCHIVED, open)}
            here={here}
            path={path}
            viewer={viewer}
            names={names}
            archived
          />
        )
        : null}
    </ul>
  );
}

/** Spaces apart (archived, or the org's others), folded: quieter rows, each a link to its page. */
function Apart(
  { title, icon, hint, spaces, open, fold, here, path, viewer, names, archived }: {
    title: string;
    icon: "archive" | "building";
    hint?: string;
    spaces: Reached[];
    open: boolean;
    fold(open: boolean): void;
    here?: string;
    path?: string;
    viewer: string;
    names: Record<string, string>;
    archived?: boolean;
  },
): ReactNode {
  const id = useId();
  return (
    <li className="spaces-archived" data-open={open || undefined}>
      <NavItem
        quiet
        onClick={() => fold(!open)}
        title={hint}
        leading={
          <span className="spaces-archived-icon">
            <Icon name={icon} size={14} />
          </span>
        }
        end={
          <span className="spaces-archived-end">
            <span className="spaces-archived-count">{spaces.length}</span>
            <Icon name="chevron" size={14} />
          </span>
        }
        aria-expanded={open}
        aria-controls={open ? id : undefined}
      >
        {title}
      </NavItem>
      {open
        ? (
          <ul
            id={id}
            className="spaces spaces-archived-list"
            aria-label={say("spacesUnder", { title })}
          >
            {spaces.map((s) => {
              const name = spaceName(s, viewer, names);
              return (
                <li key={s._id}>
                  <NavItem
                    quiet
                    href={spacePath(s._id)}
                    current={path === spacePath(s._id)
                      ? "page"
                      : s._id === here
                      ? "location"
                      : undefined}
                    title={archived ? say("nameArchived", { name }) : name}
                    leading={theirsAlone(s, viewer)
                      ? <Avatar name={nameOf(s.owner ?? "", names)} size={20} />
                      : <Avatar name={s.name} kind="space" size={20} />}
                  >
                    {name}
                  </NavItem>
                </li>
              );
            })}
          </ul>
        )
        : null}
    </li>
  );
}

function SpaceRow(
  { space, viewer, names, here, page, open, fold, under, path }: {
    space: Reached;
    viewer: string;
    names: Record<string, string>;
    here: boolean;
    page: boolean;
    open: boolean;
    fold(open: boolean): void;
    under: SpaceSidebar[];
    path?: string;
  },
): ReactNode {
  const name = spaceName(space, viewer, names);
  const personal = space.kind === "personal";
  const id = useId();
  const what = listed(under.flatMap((u) => u.title ? [u.title] : []));
  return (
    <li className="spaces-item" data-open={open || undefined}>
      <div className="spaces-row">
        <NavItem
          href={spacePath(space._id)}
          current={page ? "page" : here ? "location" : undefined}
          title={personal ? say("personalHint") : space.name}
          leading={personal
            ? (
              <span className="spaces-personal">
                <Icon name="person" size={13} />
              </span>
            )
            : <Avatar name={space.name} kind="space" size={22} />}
        >
          {name}
        </NavItem>
        {under.length
          ? (
            <IconButton
              icon="chevron"
              label={what
                ? say(open ? "hideWhat" : "showWhat", { name, what })
                : say(open ? "hideIn" : "showIn", { name })}
              tooltip={false}
              size="sm"
              className="spaces-fold"
              aria-expanded={open}
              aria-controls={open ? id : undefined}
              onClick={() => fold(!open)}
            />
          )
          : null}
      </div>
      {open && under.length
        ? (
          <div id={id} className="spaces-under">
            {under.map((u) => (
              <LazyView
                key={u.view}
                kind={u.view}
                item={{ _id: space._id }}
                hints={{ in: space._id, ...(path ? { path } : {}) }}
              />
            ))}
          </div>
        )
        : null}
    </li>
  );
}

/**
 * The spaces on the rail, the sidebar folded: those in use that the tree lists as the person's
 * own, each its face (Personal, a person's), a link to its page, named beside it; where they work
 * tinted, and its page raised. Archived spaces and the org's others wait in the tree.
 */
export function SpaceRail(
  { spaces, joined = [], here, path, viewer, call }: {
    /** Those in use, in the sidebar's order. */
    spaces: Reached[];
    joined?: Member[];
    here?: string;
    path?: string;
    viewer: string;
    call?: Call;
  },
): ReactNode {
  const { runs } = useRunning(joined, call);
  const mine = ownOf(joined, viewer, runs);
  return (
    <ul className="spaces-rail" aria-label={say("spacesGroup")}>
      {spaces.filter(mine).map((s) => (
        <li key={s._id}>
          <RailItem
            href={spacePath(s._id)}
            label={spaceName(s, viewer)}
            current={path === spacePath(s._id) ? "page" : s._id === here ? "location" : undefined}
            leading={s.kind === "personal"
              ? (
                <span className="spaces-personal">
                  <Icon name="person" size={14} />
                </span>
              )
              : <Avatar name={s.name} kind="space" size={26} />}
          />
        </li>
      ))}
    </ul>
  );
}
