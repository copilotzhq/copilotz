/**
 * The toolkit's gallery, at `/gallery`: the app's logo and type, and every
 * piece of the web host's toolkit and its variants, in the app's theme
 * (light or dark, as the screen is), with the theme's tokens and radii,
 * chat's voice messages in each of their states (gallery-voice.tsx), and code
 * blocks and a terminal to try (gallery-code.tsx). For whoever builds or
 * rebrands the app; the sidebar doesn't link it.
 */
import { type CSSProperties, type ReactNode, useId, useState } from "react";
import { definePlugin, type Plugin } from "../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  CopyButton,
  DetailList,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Icon,
  IconButton,
  ICONS,
  InlineEdit,
  Input,
  Kbd,
  Logo,
  Markdown,
  Menu,
  Notice,
  Page,
  ResizeHandle,
  Select,
  Skeleton,
  Spinner,
  Tabs,
  Textarea,
  Time,
  Title,
  Tooltip,
} from "../../hosts/web/mod.ts";
import { CodeGallery } from "./gallery-code.tsx";
import { VoiceGallery } from "./gallery-voice.tsx";

const STYLE = `
.gallery-section { margin-top: 34px; }
.gallery-terminal { grid-column: 1 / -1; display: grid; height: 260px; }
.gallery-section:first-child { margin-top: 14px; }
.gallery-title { margin: 0 0 12px; font-size: 12px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase;
  color: var(--muted-foreground); }
.gallery-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.gallery-row + .gallery-row { margin-top: 12px; }
.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.gallery-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.gallery-swatch { display: flex; align-items: center; gap: 10px; font: 12px var(--font-mono); color: var(--secondary-foreground); }
.gallery-swatch i { flex: none; width: 32px; height: 32px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.gallery-radius { display: grid; place-items: end start; width: 76px; height: 56px; padding: 6px 8px;
  border: 1px solid var(--primary-border); background: var(--primary-soft); color: var(--primary-text);
  font: 11px var(--font-mono); }
.gallery-logos { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.gallery-logo { display: flex; align-items: center; justify-content: center; gap: 22px; min-height: 120px;
  padding: 20px; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--card); }
.gallery-logo-muted { background: var(--sidebar); }
.gallery-type { display: grid; gap: 14px; margin-top: 18px; }
.gallery-type p { margin: 0; display: grid; gap: 2px; }
.gallery-type small { color: var(--muted-foreground); font: 11.5px var(--font-mono); }
.gallery-display { font-family: var(--font-display); font-size: 30px; font-weight: 680; line-height: 1.15;
  letter-spacing: -.025em; }
.gallery-text { font-size: 17px; }
.gallery-code { font-family: var(--font-mono); font-size: 14px; }
.gallery-icons { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 6px; }
.gallery-icons span { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-md);
  color: var(--secondary-foreground); font-size: 12px; }
.gallery-icons span:hover { background: var(--accent); }
.gallery-panel { border: 1px dashed var(--input); border-radius: var(--radius-xl); padding: 28px 16px; }
.gallery-drawer { padding: 4px 20px 20px; display: grid; gap: 12px; }
.gallery-split { display: flex; height: 120px; margin-top: 14px; border: 1px dashed var(--input);
  border-radius: var(--radius-xl); overflow: hidden; }
.gallery-split > span { display: grid; place-items: center; padding: 12px; color: var(--muted-foreground);
  font-size: 13px; text-align: center; }
.gallery-split > span:first-child { flex: 1; }
.gallery-split > span:last-child { flex: none; background: var(--muted); }
.gallery-pages { display: grid; grid-template-columns: minmax(0, 1fr) 340px; align-items: start; gap: 14px; }
.gallery-frame { border: 1px dashed var(--input); border-radius: var(--radius-xl); overflow: hidden;
  background: var(--background); }
.gallery-frame-label { margin: 0; padding: 8px 14px; border-bottom: 1px dashed var(--input); color: var(--muted-foreground);
  font: 11.5px var(--font-mono); }
@media (max-width: 900px) { .gallery-pages { grid-template-columns: minmax(0, 1fr); } }
`;

/** The app's name, which its logo says: the title the page came with. */
const app = globalThis.document?.title || "Copilotz";

/** A document as a detail page shows it: one of each kind of value. */
const now = Date.now();
const DOCUMENT = {
  name: "Launch checklist",
  createdAt: new Date(now - 4 * 60_000).toISOString(),
  updatedAt: new Date(now - 3 * 86_400_000),
  due: "2026-11-14",
  core: true,
  archived: false,
  messages: 12840,
  owner: null,
  labels: ["launch", "q4", "web"],
  tags: { thread: "0b7f3c2e-5d1a-4c8e-9f60-2a8d4e1b7c93", kind: "planning" },
  source: {
    thread: "4d2e8a10-77c3-4f0b-a1e5-93b6c2d8f047",
    by: "assistant",
    at: "2026-10-20T14:05:00Z",
  },
  limits: {
    daily: 2000,
    monthly: 50000,
    currency: "USD",
    alerts: true,
    window: "rolling",
    reset: "2026-11-01T00:00:00Z",
    owner: "ana",
  },
  notes: "Ship the web app in November. Bob owns the backend checks; Ana signs off on the " +
    "design. Every item has an owner and a date, and we review the list on Mondays and " +
    "Thursdays.\n\nOpen questions: whether the beta goes to the whole team first, and who " +
    "writes the announcement. Keep the list short: what's done moves to the archive.",
  homepage: "https://example.com/launch",
  embedding: Array.from({ length: 24 }, (_, i) => Math.round(Math.sin(i + 1) * 1000) / 1000),
  _id: "3f9c1e72-8b4d-4a1f-b2e6-7d5c0a9e4f18",
};

/** The same document's rows, as a full page lists them: a path into a field, a label of its own. */
const ROWS = [
  "createdAt",
  "updatedAt",
  "due",
  { field: "core", label: "Always in mind" },
  "archived",
  "messages",
  "owner",
  "labels",
  "tags.thread",
  "source",
  "limits",
  "notes",
  "homepage",
  "embedding",
  "_id",
];

/** Fewer, for a panel. */
const PANEL_ROWS = ["createdAt", "core", "messages", "owner", "labels", "notes", "_id"];

const TOKENS = [
  "background",
  "foreground",
  "card",
  "popover",
  "primary",
  "primary-foreground",
  "primary-text",
  "primary-soft",
  "primary-border",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "border",
  "input",
  "ring",
  "sidebar",
  "bubble",
  "bubble-foreground",
  "destructive",
  "destructive-soft",
  "success",
  "success-soft",
  "warning",
  "warning-soft",
  "info",
  "info-soft",
];

const SAMPLE = `### Markdown
Agents write **bold**, *emphasis*, \`code\` and [links](https://example.com); lists:

- [x] A task that's done
- [ ] One that isn't

| Token | Role |
| :-- | :-- |
| \`primary\` | The brand |

\`\`\`ts
export const health = () => ({ ok: true });
\`\`\``;

function Gallery(): ReactNode {
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState("all");
  const [line, setLine] = useState("overview");
  const [checked, setChecked] = useState(true);
  const [side, setSide] = useState(false);
  const [name, setName] = useState("Launch");
  const [renaming, setRenaming] = useState(false);
  const [split, setSplit] = useState(220);
  const panel = useId();
  const minute = new Date(Date.now() - 4 * 60_000).toISOString();
  return (
    <Page
      title="Design system"
      description="Every piece of the web host's toolkit, in this app's theme."
      width="lg"
    >
      <style href="gallery" precedence="copilotz">{STYLE}</style>
      <Title text="Design system" />
      <section className="gallery-section" data-gallery="logo">
        <h2 className="gallery-title">Logo and type</h2>
        <div className="gallery-logos">
          <div className="gallery-logo">
            <Logo variant="full" name={app} size={44} />
          </div>
          <div className="gallery-logo gallery-logo-muted">
            <Logo size={64} />
            <Logo size={40} />
            <Logo size={24} />
            <Logo size={16} />
          </div>
          <div className="gallery-logo gallery-logo-muted">
            <Logo variant="full" name={app} size={28} />
          </div>
        </div>
        <div className="gallery-type">
          <p>
            <small>--font-display</small>
            <span className="gallery-display">Agents that work together</span>
          </p>
          <p>
            <small>--font-sans</small>
            <span className="gallery-text">
              Ask anything, in any space: your agents answer, remember, and hand work along.
            </span>
          </p>
          <p>
            <small>--font-mono</small>
            <span className="gallery-code">{"roll_dice({ sides: 20 }) → 17"}</span>
          </p>
        </div>
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Tokens</h2>
        <div className="gallery-swatches">
          {TOKENS.map((token) => (
            <span key={token} className="gallery-swatch">
              <i style={{ background: `var(--${token})` }} />
              {token}
            </span>
          ))}
        </div>
        <div className="gallery-row" style={{ marginTop: 16 }}>
          {["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].map((r) => (
            <span
              key={r}
              className="gallery-radius"
              style={{ borderRadius: `var(--radius-${r})` } as CSSProperties}
            >
              {r}
            </span>
          ))}
        </div>
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Buttons</h2>
        <div className="gallery-row">
          <Button variant="primary" icon="compose">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button>Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive" icon="trash">Destructive</Button>
          <Button variant="link" href="#">Link</Button>
        </div>
        <div className="gallery-row">
          <Button size="sm" icon="share">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg" variant="primary">Large</Button>
          <Button loading>Saving…</Button>
          <Button disabled>Disabled</Button>
          <Button iconEnd="chevron-down">With an end icon</Button>
        </div>
        <div className="gallery-row">
          <IconButton icon="close" label="Ghost" />
          <IconButton icon="copy" label="Outline" variant="outline" />
          <IconButton icon="star" label="Secondary" variant="secondary" />
          <IconButton icon="send" label="Primary" variant="primary" />
          <IconButton icon="send" label="Primary, disabled" variant="primary" disabled />
          <IconButton icon="plus" label="Small" size="sm" />
          <IconButton icon="menu" label="Large" size="lg" />
          <IconButton icon="download" label="Loading" loading />
          <CopyButton text="Copied from the gallery" />
        </div>
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Fields</h2>
        <div className="gallery-grid">
          <Field label="Name" hint="Letters, digits, dots and dashes.">
            {(control) => <Input {...control} placeholder="e.g. ana" />}
          </Field>
          <Field label="Search" hint="An icon before, and a button after.">
            {(control) => (
              <Input
                {...control}
                icon="search"
                placeholder="Search memories"
                end={<IconButton icon="close" label="Clear" size="sm" />}
              />
            )}
          </Field>
          <Field label="Space" error="That name is taken.">
            {(control) => <Input {...control} defaultValue="Launch" />}
          </Field>
          <Field label="Role">
            {(control) => (
              <Select {...control} defaultValue="editor">
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="manager">Manager</option>
              </Select>
            )}
          </Field>
          <Field label="Instructions" hint="Grows as you write.">
            {(control) => (
              <Textarea
                {...control}
                autoGrow
                defaultValue="You research questions others send."
              />
            )}
          </Field>
          <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <Checkbox
              label="Core: always in mind"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <Checkbox label="Remind me tomorrow" />
            <Checkbox label="Disabled" disabled />
            <Input size="sm" placeholder="Small" disabled />
            <Input size="lg" placeholder="Large" />
          </div>
          <div
            style={{ display: "grid", gap: 7, alignContent: "start" }}
            data-gallery="inline-edit"
          >
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Renamed in place</span>
            {renaming
              ? (
                <InlineEdit
                  label="The space's name"
                  value={name}
                  save={(next) => Promise.resolve(setName(next))}
                  done={() => setRenaming(false)}
                />
              )
              : (
                <Button variant="ghost" iconEnd="pencil" onClick={() => setRenaming(true)}>
                  {name}
                </Button>
              )}
          </div>
        </div>
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Cards, badges, chips and avatars</h2>
        <div className="gallery-grid">
          <Card>
            <strong>A card</strong>
            <p style={{ margin: "4px 0 0", color: "var(--muted-foreground)" }}>
              Bordered, on the card color, softly raised.
            </p>
          </Card>
          <Card as="button" interactive>
            <strong>An interactive card</strong>
            <p style={{ margin: "4px 0 0", color: "var(--muted-foreground)" }}>
              A button that looks like a card.
            </p>
          </Card>
        </div>
        <div className="gallery-row" style={{ marginTop: 14 }}>
          <Badge>neutral</Badge>
          <Badge tone="primary">primary</Badge>
          <Badge tone="success">success</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="destructive">destructive</Badge>
          <Badge tone="info">info</Badge>
          <Badge variant="outline">outline</Badge>
          <Badge tone="primary" variant="solid">solid</Badge>
          <Badge tone="success" variant="solid">3</Badge>
        </div>
        <div className="gallery-row">
          <Chip size="sm" icon="person">Personal</Chip>
          <Chip size="sm">
            <Avatar name="Launch" kind="space" size={14} />
            Launch
          </Chip>
          <Chip size="sm" variant="primary" icon="chat">Waiting on your answer</Chip>
          <Chip variant="outline" icon="tool" onClick={() => {}}>Used roll_dice</Chip>
          <Chip size="lg" variant="outline" onClick={() => {}}>Help me plan a calm week</Chip>
          <Chip size="lg" variant="primary" onClick={() => {}}>Primary, interactive</Chip>
        </div>
        <div className="gallery-row">
          <Avatar name="ana" size={36} />
          <Avatar name="bob" />
          <Avatar name="assistant" kind="agent" size={36} />
          <Avatar name="researcher" kind="agent" />
          <Avatar name="Maya" kind="agent" icon="🦉" size={36} />
          <Avatar name="Launch" kind="space" size={36} />
          <Avatar name="Finance" kind="space" />
        </div>
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Overlays and navigation</h2>
        <div className="gallery-row">
          <span data-gallery="menu">
            <Menu
              label="Conversation actions"
              items={[
                { label: "Share", icon: "share", shortcut: "⌘S", onSelect: () => {} },
                { label: "Copy link", icon: "copy", onSelect: () => {} },
                { label: "Rename", icon: "compose", onSelect: () => setDialog(true) },
                { label: "Archived", icon: "file", disabled: true },
                "separator",
                { label: "Delete", icon: "trash", tone: "destructive", onSelect: () => {} },
              ]}
            />
          </span>
          <Menu
            label="Sort"
            text="Newest first"
            items={[{ label: "Newest first" }, { label: "Oldest first" }, { label: "By space" }]}
          />
          <span data-gallery="dialog">
            <Button onClick={() => setDialog(true)}>Open a dialog</Button>
          </span>
          <span data-gallery="drawer">
            <Button onClick={() => setDrawer(true)}>Open a drawer</Button>
          </span>
          <span data-gallery="tooltip">
            <Tooltip text="Was: Ana lives in Porto">
              <Button variant="ghost" icon="info">Hover or focus me</Button>
            </Tooltip>
          </span>
        </div>
        <div className="gallery-row" data-gallery="tabs">
          <Tabs
            label="Which memories"
            value={tab}
            onChange={setTab}
            panel={panel}
            tabs={[
              { value: "all", label: "All", count: 12 },
              { value: "core", label: "Core", icon: "star", count: 3 },
              { value: "mine", label: "About you", count: 5 },
            ]}
          />
          <Tabs
            variant="line"
            label="Agent"
            value={line}
            onChange={setLine}
            tabs={[
              { value: "overview", label: "Overview" },
              { value: "tools", label: "Tools", count: 5 },
              { value: "usage", label: "Usage" },
            ]}
          />
        </div>
        <p id={panel} role="tabpanel" style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          Showing: {tab}; {line}.
        </p>
        <div className="gallery-split" data-gallery="resize">
          <span>The page</span>
          <ResizeHandle
            label="Panel width"
            value={split}
            min={140}
            max={420}
            onChange={setSplit}
            onReset={() => setSplit(220)}
          />
          <span style={{ width: split }}>A side panel: drag its edge, or use the arrow keys</span>
        </div>
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Status</h2>
        <div className="gallery-grid">
          <Notice title="Heads up">Agents read this space's notes before answering.</Notice>
          <Notice tone="success">Saved. Everyone here sees it now.</Notice>
          <Notice
            tone="warning"
            icon="lock"
            action={<Button size="sm" icon="share">Share</Button>}
          >
            Uses <b>Finance</b>. Not everyone here can see it.
          </Notice>
          <Notice
            tone="destructive"
            title="Something went wrong here"
            action={<Button size="sm">Reload</Button>}
          >
            The connection closed.
          </Notice>
          <Notice tone="neutral">A neutral note, for what's merely so.</Notice>
        </div>
        <div className="gallery-row" style={{ marginTop: 14 }}>
          <Spinner />
          <Spinner size={22} />
          <span style={{ color: "var(--primary-text)" }}>
            <Spinner variant="dots" />
          </span>
          <Kbd>Enter</Kbd>
          <Kbd>⌘K</Kbd>
          <Time at={minute} />
          <Skeleton width={180} height={14} />
          <Skeleton width={120} height={28} radius="full" />
        </div>
        <div className="gallery-grid" style={{ marginTop: 14 }}>
          <div className="gallery-panel">
            <EmptyState icon="lock" title="This conversation isn't here">
              It may have moved, or it isn't shared with you.
            </EmptyState>
          </div>
          <div className="gallery-panel">
            <EmptyState
              icon="sparkles"
              tone="primary"
              title="Nothing remembered yet"
              action={<Button variant="primary" icon="compose">Start a conversation</Button>}
            >
              As you talk, agents keep what will matter later.
            </EmptyState>
          </div>
        </div>
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Pages and details</h2>
        <div className="gallery-pages">
          <div className="gallery-frame" data-gallery="page-full">
            <p className="gallery-frame-label">density="full"</p>
            <Page
              heading="h3"
              title={DOCUMENT.name}
              back={{ href: "/gallery", label: "Spaces" }}
              leading={<Avatar name="Launch" kind="space" size={40} />}
              badges={
                <>
                  <Badge tone="primary">shared</Badge>
                  <Badge tone="success">on track</Badge>
                </>
              }
              actions={
                <>
                  <Button size="sm" icon="share">Share</Button>
                  <IconButton icon="more" label="More" variant="outline" size="sm" />
                </>
              }
              description="Where the launch team keeps its plan: owners, dates and what's left."
            >
              <DetailList item={DOCUMENT} fields={ROWS} />
            </Page>
          </div>
          <div className="gallery-frame" data-gallery="page-panel">
            <p className="gallery-frame-label">density="panel"</p>
            <Page
              density="panel"
              heading="h3"
              title={DOCUMENT.name}
              icon="file"
              badges={<Badge tone="primary">shared</Badge>}
              actions={<IconButton icon="more" label="More" size="sm" />}
              description="The same View, in a side panel."
            >
              <DetailList item={DOCUMENT} fields={PANEL_ROWS} />
            </Page>
          </div>
        </div>
        <div className="gallery-row" style={{ marginTop: 14 }}>
          <span data-gallery="side-panel">
            <Button icon="file" onClick={() => setSide(true)}>Open as a side panel</Button>
          </span>
          <span style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
            A <code>DetailList</code> stacks in a panel, and wherever it's narrow.
          </span>
        </div>
      </section>

      <section className="gallery-section" data-gallery="sound">
        <h2 className="gallery-title">Sound</h2>
        <VoiceGallery />
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Markdown</h2>
        <Card>
          <Markdown text={SAMPLE} />
        </Card>
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Code and terminals</h2>
        <CodeGallery />
      </section>

      <section className="gallery-section">
        <h2 className="gallery-title">Icons</h2>
        <div className="gallery-icons">
          {ICONS.map((name) => (
            <span key={name}>
              <Icon name={name} />
              {name}
            </span>
          ))}
        </div>
      </section>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Rename the conversation"
        description="Everyone in it sees the new name."
        footer={
          <>
            <Button onClick={() => setDialog(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setDialog(false)}>Rename</Button>
          </>
        }
      >
        <Field label="Name">
          {(control) => <Input {...control} defaultValue="Launch checklist" autoFocus />}
        </Field>
      </Dialog>
      <Drawer open={drawer} onClose={() => setDrawer(false)} title="Filters" side="right">
        <div className="gallery-drawer">
          <Checkbox label="Only core memories" defaultChecked />
          <Checkbox label="Only this space" />
          <Field label="About">
            {(control) => (
              <Select {...control}>
                <option>Anyone</option>
                <option>You</option>
              </Select>
            )}
          </Field>
          <Button variant="primary" onClick={() => setDrawer(false)}>Apply</Button>
        </div>
      </Drawer>
      <Drawer open={side} onClose={() => setSide(false)} side="right" label={DOCUMENT.name}>
        <Page
          density="panel"
          title={DOCUMENT.name}
          icon="file"
          badges={<Badge tone="primary">shared</Badge>}
          description="The same View, in a side panel."
          actions={<IconButton icon="close" label="Close" onClick={() => setSide(false)} />}
        >
          <DetailList item={DOCUMENT} fields={PANEL_ROWS} />
        </Page>
      </Drawer>
    </Page>
  );
}

export const gallery: Plugin = definePlugin({
  name: "gallery",
  views: { gallery: { web: () => <Gallery /> } },
});
