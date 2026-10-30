/**
 * A space's skills (kind `skills`: its Skills tab, item `{ _id }`, the
 * space): those made there, then the app's, each by its name, what it's
 * for and its files, opening its page. Those who manage the space write a
 * new one (from a SKILL.md, or field by field) and change or delete theirs
 * from each one's menu; everyone else reads them. With none at all, it says
 * what a skill is, and how to make one. In a side panel, the same, compact.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  go,
  Icon,
  IconButton,
  Input,
  Menu,
  type MenuItem,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Shown } from "../../shared/skills.ts";
import { DeleteSkill } from "./delete.tsx";
import { SkillForm } from "./form.tsx";
import { blank, matches, skillPath } from "./skills.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Place = { _id: string; name: string; kind: string; can?: string[]; archived?: string };

/** What a space is called where it shows: yours is "Personal". */
const placeName = (p: Pick<Place, "name" | "kind">) => p.kind === "personal" ? "Personal" : p.name;

/** Past this many, a search shows. */
const SEARCHED = 6;

export const skillsView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const listed = ctx.db.collection("skill").query<Shown[]>("list", { in: space }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const compact = ctx.hints.mode === "panel";
  const style = <style href="skills-web" precedence="copilotz">{STYLE}</style>;
  if (!listed || !places) {
    return (
      <div className="skills" aria-busy="true">
        {style}
        {[0, 1, 2].map((i) => <Skeleton key={i} height={compact ? 52 : 64} radius="lg" />)}
      </div>
    );
  }
  const place = places.find((p) => p._id === space);
  return (
    <>
      {style}
      <Skills
        space={space}
        where={place ? placeName(place) : "this space"}
        manage={!!place?.can?.includes("manage") && !place.archived}
        skills={listed}
        compact={compact}
        call={ctx.call}
      />
    </>
  );
};

function Skills(
  { space, where, manage, skills, compact, call }: {
    space: string;
    /** The space's name, as it's shown. */
    where: string;
    manage: boolean;
    skills: Shown[];
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [search, setSearch] = useState("");
  const [writing, setWriting] = useState(false);
  const [deleting, setDeleting] = useState<Shown>();
  const shown = skills.filter((s) => matches(s, search));
  const made = shown.filter((s) => s.source === "space");
  const app = shown.filter((s) => s.source === "app");
  const write = () => setWriting(true);
  const form = (
    <Dialog
      open={writing}
      onClose={() => setWriting(false)}
      size="lg"
      title={`New skill in ${where}`}
      description="Agents here see its name and what it's for, and read the rest when a task fits."
    >
      {writing
        ? (
          <SkillForm
            space={space}
            was={blank()}
            call={call}
            compact
            done={(skill) => {
              setWriting(false);
              go(skillPath(skill, space));
            }}
          />
        )
        : null}
    </Dialog>
  );

  if (!skills.length) {
    return (
      <div className={`skills${compact ? " skills-compact" : ""}`}>
        <EmptyState
          icon="tool"
          tone="primary"
          title="Teach your agents a skill"
          className="skills-empty"
          action={manage
            ? <Button variant="primary" icon="plus" onClick={write}>Write a skill</Button>
            : null}
        >
          A skill is know-how agents read only when a task calls for it. {manage
            ? "Write one, or bring a SKILL.md you have."
            : `Those who manage ${where} add them here.`}
        </EmptyState>
        <ol className="skills-anatomy" aria-label="What a skill is">
          <li>
            <b>A name</b>
            <span>
              What agents call it, like <code>weekly-report</code>.
            </span>
          </li>
          <li>
            <b>When it's for</b>
            <span>Agents see only this, with its name, until a task fits.</span>
          </li>
          <li>
            <b>Instructions and files</b>
            <span>Steps, templates and references, read when it's used.</span>
          </li>
        </ol>
        {form}
      </div>
    );
  }

  const row = (s: Shown) => {
    const items: (MenuItem | "separator")[] = [
      { label: "Open", icon: "external", href: skillPath(s._id, space) },
      ...(manage && s.source === "space"
        ? [
          { label: "Edit", icon: "pencil" as const, href: skillPath(s._id, space, true) },
          "separator" as const,
          {
            label: "Delete…",
            icon: "trash" as const,
            tone: "destructive" as const,
            onSelect: () => setDeleting(s),
          },
        ]
        : []),
    ];
    return (
      <li key={s._id} className="skills-item">
        <a className="skills-row" href={skillPath(s._id, space)}>
          <span className="skills-row-icon" data-app={s.source === "app" || undefined}>
            <Icon name={s.source === "app" ? "lock" : "tool"} size={16} />
          </span>
          <span className="skills-row-text">
            <span className="skills-row-name">{s.name}</span>
            <span className="skills-row-what">{s.description}</span>
          </span>
          <span className="skills-row-meta">
            {s.files.length
              ? <span>{s.files.length} file{s.files.length === 1 ? "" : "s"}</span>
              : <span>Instructions only</span>}
            {s.updated ?? s.at ? <Time at={(s.updated ?? s.at)!} /> : null}
          </span>
        </a>
        <span className="skills-row-menu">
          <Menu label={`${s.name}: more`} align="end" size="sm" items={items} />
        </span>
      </li>
    );
  };

  return (
    <div className={`skills${compact ? " skills-compact" : ""}`}>
      {compact ? null : (
        <div className="skills-head">
          <p className="skills-intro">
            Know-how agents read only when a task needs it. Each agent here sees these names and
            what they're for.
          </p>
          {manage
            ? (
              <div className="skills-actions">
                <Button variant="primary" icon="plus" onClick={write}>New skill</Button>
              </div>
            )
            : null}
        </div>
      )}
      {skills.length > SEARCHED || compact
        ? (
          <div className="skills-head">
            <Input
              icon="search"
              type="search"
              size={compact ? "sm" : "md"}
              className="skills-search"
              aria-label="Search skills"
              placeholder={`Search ${skills.length} skill${skills.length === 1 ? "" : "s"}`}
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {compact && manage
              ? <IconButton icon="plus" label="New skill" variant="outline" onClick={write} />
              : null}
          </div>
        )
        : null}
      {made.length || (!search && manage)
        ? (
          <section className="skills-group" aria-label={`Made in ${where}`}>
            <h3>Made in {where}</h3>
            {made.length
              ? <ul className="skills-list">{made.map(row)}</ul>
              : (
                <button type="button" className="skills-add" onClick={write}>
                  <span className="skills-add-plus">
                    <Icon name="plus" size={16} />
                  </span>
                  <span className="skills-row-text">
                    <span className="skills-add-say">Write a skill of your own</span>
                    <span className="skills-row-what">
                      Or bring a SKILL.md you have: drop it in, upload its folder, or paste it.
                    </span>
                  </span>
                </button>
              )}
          </section>
        )
        : null}
      {app.length
        ? (
          <section className="skills-group" aria-label="From the app">
            <h3>
              From the app <Badge variant="outline">Read only</Badge>
            </h3>
            <ul className="skills-list">{app.map(row)}</ul>
          </section>
        )
        : null}
      {search && !shown.length ? <p className="skills-none">No skills match “{search}”.</p> : null}
      {form}
      {deleting
        ? (
          <DeleteSkill
            open
            onClose={() => setDeleting(undefined)}
            skill={deleting._id}
            name={deleting.name}
            space={where}
            call={call}
          />
        )
        : null}
    </div>
  );
}
