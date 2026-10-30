/**
 * A skill's page (kind `skill`, at `/skill/<id>`; the app's are
 * `app:<name>`): its name, where it's from and what it's for, then what it
 * says: its instructions, and each of its files a tab (`?file=`), read as
 * a page (Markdown) or as it's written. Those who manage its space change
 * it in place (`?edit=1`) and delete it; anyone downloads or copies its
 * SKILL.md. The app's skills are read only.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  bytes,
  Card,
  CodeBlock,
  CopyButton,
  EmptyState,
  go,
  IconButton,
  Markdown,
  Menu,
  type MenuItem,
  Notice,
  Page,
  Skeleton,
  Tabs,
  Time,
  Title,
} from "../../../../../hosts/web/mod.ts";
import { SKILL_MD } from "../../shared/check.ts";
import { formatSkillMd } from "../../shared/skill-md.ts";
import type { Shown } from "../../shared/skills.ts";
import { DeleteSkill } from "./delete.tsx";
import { SkillForm } from "./form.tsx";
import { markdownish, skillPath, skillsTab } from "./skills.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Read = { skill: Shown; file: string; text?: string; missing?: true } | null;
type Place = { _id: string; name: string; kind: string; can?: string[]; archived?: string };

const placeName = (p: Pick<Place, "name" | "kind">) => p.kind === "personal" ? "Personal" : p.name;

/** Saves text as a file, in the browser. */
function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const skillView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  const file = query.file || SKILL_MD;
  const main = ctx.db.collection("skill").query<Read>("read", { skill: id }).value;
  const shownFile = file === SKILL_MD
    ? main
    : ctx.db.collection("skill").query<Read>("read", { skill: id, file }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  // Its files' text, only to change them.
  const editing = query.edit === "1";
  const files = editing
    ? ctx.db.collection("skill").query<{ path: string; text: string }[]>("files", { skill: id })
      .value
    : undefined;
  const style = <style href="skills-web" precedence="copilotz">{STYLE}</style>;
  if (main === undefined || shownFile === undefined || !places) {
    return (
      <Page title={<Skeleton width={220} height={30} />} icon="tool">
        {style}
        <div className="skill-loading" aria-busy="true">
          <Skeleton height={36} width="50%" />
          <Skeleton height={280} radius="xl" />
        </div>
      </Page>
    );
  }
  if (!main) {
    return (
      <div className="skill-missing">
        {style}
        <Title text="No such skill" />
        <EmptyState
          icon="tool"
          heading="h1"
          title="No skill here by that name"
          action={<Button variant="primary" icon="home" href="/">Go home</Button>}
        >
          It may have been deleted, or it's in a space you're not in.
        </EmptyState>
      </div>
    );
  }
  const space = main.skill.in ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : undefined);
  const place = places.find((p) => p._id === space);
  return (
    <>
      {style}
      <SkillPage
        key={id}
        skill={main.skill}
        instructions={main.text ?? ""}
        file={file}
        shown={shownFile}
        space={space}
        place={place}
        editing={editing}
        files={files}
        call={ctx.call}
      />
    </>
  );
};

function SkillPage(
  { skill, instructions, file, shown, space, place, editing: asked, files, call }: {
    skill: Shown;
    instructions: string;
    file: string;
    shown: Read;
    space?: string;
    place?: Place;
    /** The address asks for it changed (`?edit=1`). */
    editing: boolean;
    /** Its files' text, while it's being changed. */
    files?: { path: string; text: string }[];
    call: Call;
  },
): ReactNode {
  const app = skill.source === "app";
  const where = place ? placeName(place) : "its space";
  const manage = !app && !!place?.can?.includes("manage") && !place.archived;
  const editing = asked && manage;
  const [deleting, setDeleting] = useState(false);
  const [source, setSource] = useState(false);
  const md = formatSkillMd({ name: skill.name, description: skill.description, instructions });
  const here = (to: string) =>
    `${skillPath(skill._id, space)}${
      to === SKILL_MD ? "" : `${space ? "&" : "?"}file=${encodeURIComponent(to)}`
    }`;
  // Changing it is an address of its own, so its files are read only then.
  const edit = () => go(skillPath(skill._id, space, true));
  const stop = () => go(skillPath(skill._id, space));
  const more: (MenuItem | "separator")[] = [
    { label: "Download SKILL.md", icon: "download", onSelect: () => save(`${skill.name}.md`, md) },
    ...(manage
      ? [
        "separator" as const,
        {
          label: `Delete ${skill.name}…`,
          icon: "trash" as const,
          tone: "destructive" as const,
          onSelect: () => setDeleting(true),
        },
      ]
      : []),
  ];
  const text = shown?.text;
  const isMd = markdownish(file);
  return (
    <Page
      icon={app ? "lock" : "tool"}
      title={skill.name}
      back={space ? { href: skillsTab(space), label: `${where} · Skills` } : undefined}
      badges={app ? <Badge>Part of the app</Badge> : <Badge tone="primary">Made in {where}</Badge>}
      description={skill.description}
      actions={editing ? null : (
        <>
          {manage
            ? (
              <>
                <Button icon="pencil" className="skill-wide" onClick={edit}>
                  Edit
                </Button>
                <IconButton
                  icon="pencil"
                  label={`Edit ${skill.name}`}
                  variant="outline"
                  className="skill-narrow"
                  onClick={edit}
                />
              </>
            )
            : null}
          <Menu label={`${skill.name}: more`} align="end" items={more} />
        </>
      )}
    >
      <Title text={skill.name} />
      {editing && space
        ? (
          <Card className="skill-edit-card">
            <EditSkill
              skill={skill}
              instructions={instructions}
              files={files}
              space={space}
              call={call}
              done={stop}
            />
          </Card>
        )
        : (
          <div className="skill-page">
            {app
              ? (
                <Notice tone="neutral" icon="lock">
                  Part of the app: it's set up in code, so it isn't changed here. Every agent that
                  may use it sees it, wherever it works.
                </Notice>
              )
              : null}
            {skill.files.length
              ? (
                <div className="skill-files">
                  <Tabs
                    label={`${skill.name}'s files`}
                    value={file}
                    onChange={(to) => go(here(to))}
                    tabs={[SKILL_MD, ...skill.files.map((f) => f.path)].map((path) => ({
                      value: path,
                      label: <span className="skill-file-tab">{path}</span>,
                      href: here(path),
                    }))}
                  />
                </div>
              )
              : null}
            {text === undefined
              ? (
                <Notice tone="warning" title={`${skill.name} has no ${file}`}>
                  It may have been renamed or removed.{" "}
                  <Button variant="link" size="sm" href={here(SKILL_MD)}>
                    See its instructions
                  </Button>
                </Notice>
              )
              : isMd && !source
              ? (
                <Card className="skill-doc">
                  <span className="skill-doc-tools">
                    <IconButton
                      icon="file"
                      label="Show it as it's written"
                      size="sm"
                      onClick={() => setSource(true)}
                    />
                    <CopyButton text={file === SKILL_MD ? md : text} />
                  </span>
                  {text.trim()
                    ? <Markdown text={text} />
                    : <p className="skill-note">It's empty.</p>}
                </Card>
              )
              : (
                <CodeBlock
                  code={file === SKILL_MD ? md : text}
                  title={file}
                  copy
                  wrap
                  numbers
                  actions={isMd
                    ? (
                      <Button size="sm" variant="ghost" onClick={() => setSource(false)}>
                        Read it
                      </Button>
                    )
                    : undefined}
                />
              )}
            <p className="skill-meta">
              {skill.by ? <span>Made by {skill.by.replace(/^person:/, "")}</span> : null}
              {skill.updated ?? skill.at
                ? (
                  <span>
                    {skill.updated ? "Changed" : "Made"}{" "}
                    <Time at={(skill.updated ?? skill.at)!} long />
                  </span>
                )
                : null}
              <span>
                {bytes(new Blob([instructions]).size)} of instructions
                {skill.files.length
                  ? `, ${skill.files.length} file${skill.files.length === 1 ? "" : "s"}`
                  : ""}
              </span>
            </p>
          </div>
        )}
      {manage && space
        ? (
          <DeleteSkill
            open={deleting}
            onClose={() => setDeleting(false)}
            skill={skill._id}
            name={skill.name}
            space={where}
            call={call}
            deleted={() => go(skillsTab(space))}
          />
        )
        : null}
    </Page>
  );
}

/** Changing it, in place: the form with what it says now, its files read first (`files`). */
function EditSkill(
  { skill, instructions, files, space, call, done }: {
    skill: Shown;
    instructions: string;
    files?: { path: string; text: string }[];
    space: string;
    call: Call;
    done(): void;
  },
): ReactNode {
  if (!files) return <Skeleton height={320} radius="xl" />;
  return (
    <SkillForm
      space={space}
      skill={skill._id}
      was={{ name: skill.name, description: skill.description, instructions, files }}
      call={call}
      done={done}
      cancel={done}
    />
  );
}
