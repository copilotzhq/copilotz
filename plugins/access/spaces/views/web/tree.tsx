/**
 * The spaces in the sidebar, as a tree: each space a link to its page, the
 * one you're in tinted (on its page, raised), and a fold at its end that
 * shows what's under it (the `spaceSidebar` resource's Views: its latest
 * chats), read only once it's unfolded. Where you work starts unfolded; what
 * the person folds or unfolds, this browser keeps. Archived spaces come
 * last, apart, under an Archived fold that starts folded (unless you're in
 * one), quieter, each a link to its page.
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
} from "../../../../../hosts/web/mod.ts";
import type { Reached, SpaceSidebar } from "../../contract.ts";
import { NewSpace } from "./new-space.tsx";
import { spacePath } from "./tabs.ts";
import { spaceName } from "./who.ts";

type Folds = Record<string, boolean>;

const foldsOf = (key: string): Folds => {
  try {
    const found = JSON.parse(kept(key) ?? "{}");
    return found && typeof found === "object" ? found as Folds : {};
  } catch {
    return {};
  }
};

/** The Archived fold's key among the folds kept. */
const ARCHIVED = "copilotz:archived";

export function SpaceTree(
  { spaces, archived, here, path, under, viewer, create }: {
    spaces: Reached[];
    /** Those archived, listed apart. */
    archived: Reached[];
    /** Where the person works. */
    here?: string;
    /** The address open. */
    path?: string;
    /** What a space shows under it, unfolded. */
    under: SpaceSidebar[];
    viewer: string;
    create(name: string): Promise<void>;
  },
): ReactNode {
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
          here={s._id === here}
          page={path === spacePath(s._id)}
          open={folds[s._id] ?? s._id === here}
          fold={(open) => fold(s._id, open)}
          under={under}
          path={path}
        />
      ))}
      <li>
        <NewSpace create={create} />
      </li>
      {archived.length
        ? (
          <Archived
            spaces={archived}
            open={folds[ARCHIVED] ?? archived.some((s) => s._id === here)}
            fold={(open) => fold(ARCHIVED, open)}
            here={here}
            path={path}
          />
        )
        : null}
    </ul>
  );
}

/** The archived spaces, apart and folded: quieter rows, each a link to its page. */
function Archived(
  { spaces, open, fold, here, path }: {
    spaces: Reached[];
    open: boolean;
    fold(open: boolean): void;
    here?: string;
    path?: string;
  },
): ReactNode {
  const id = useId();
  return (
    <li className="spaces-archived" data-open={open || undefined}>
      <NavItem
        quiet
        onClick={() => fold(!open)}
        leading={
          <span className="spaces-archived-icon">
            <Icon name="archive" size={14} />
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
        Archived
      </NavItem>
      {open
        ? (
          <ul id={id} className="spaces spaces-archived-list" aria-label="Archived spaces">
            {spaces.map((s) => (
              <li key={s._id}>
                <NavItem
                  quiet
                  href={spacePath(s._id)}
                  current={path === spacePath(s._id)
                    ? "page"
                    : s._id === here
                    ? "location"
                    : undefined}
                  title={`${s.name} (archived)`}
                  leading={<Avatar name={s.name} kind="space" size={20} />}
                >
                  {s.name}
                </NavItem>
              </li>
            ))}
          </ul>
        )
        : null}
    </li>
  );
}

function SpaceRow(
  { space, here, page, open, fold, under, path }: {
    space: Reached;
    here: boolean;
    page: boolean;
    open: boolean;
    fold(open: boolean): void;
    under: SpaceSidebar[];
    path?: string;
  },
): ReactNode {
  const name = spaceName(space);
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
