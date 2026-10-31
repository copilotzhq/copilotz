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
 */
import { type ReactNode, useId, useState } from "react";
import {
  asStaff,
  Avatar,
  Icon,
  IconButton,
  keep,
  kept,
  LazyView,
  NavItem,
  useOrgs,
} from "../../../../../hosts/web/mod.ts";
import type { Member, Reached, SpaceSidebar } from "../../contract.ts";
import { nameOf } from "../../shared/names.ts";
import { ORG } from "../../shared/reach.ts";
import { NewSpace } from "./new-space.tsx";
import { spacePath } from "./tabs.ts";
import { spaceName, theirsAlone } from "./who.ts";

type Folds = Record<string, boolean>;

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

export function SpaceTree(
  { spaces: reached, archived: shelved, joined = [], here, path, under, viewer, names, create }: {
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
  },
): ReactNode {
  // Those who run the org (and staff) reach every space in it: the ones they're in show as
  // anyone's do; the rest of the org's, apart.
  const orgs = useOrgs();
  const role = joined.find((m) => m.space === ORG)?.role;
  const staff = orgs.status === "ready" && asStaff(orgs.value);
  const runs = role === "owner" || role === "admin" || staff;
  // Where there are orgs, everyone in one but its guests reads their own role there.
  const guest = orgs.status === "ready" && !staff && !role;
  const theirs = new Set(joined.map((m) => m.space));
  const mine = (s: Reached) =>
    !runs || theirs.has(s._id) || (s.kind === "personal" && s.owner === viewer);
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
            title="Across the org"
            icon="building"
            hint="The org's other spaces: you reach them by running it, not as a member"
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
            title="Archived"
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
          <ul id={id} className="spaces spaces-archived-list" aria-label={`${title}: spaces`}>
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
                    title={archived ? `${name} (archived)` : name}
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
  const what = under.map((u) => u.title).filter(Boolean).join(" and ");
  const verb = open ? "Hide" : "Show";
  return (
    <li className="spaces-item" data-open={open || undefined}>
      <div className="spaces-row">
        <NavItem
          href={spacePath(space._id)}
          current={page ? "page" : here ? "location" : undefined}
          title={personal ? "Personal: just you and your agents" : space.name}
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
              label={what ? `${verb} ${name}'s ${what}` : `${verb} what's in ${name}`}
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
