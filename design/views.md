# Queries and Views

Agreed 2026-10-27. Replaces the first "views" of Copilotz 1.0 (read functions), which become
**queries**, and gives **View** the meaning it has in Copilotz 0.x and the apps on it: how a kind of
data presents itself, to a person or to a model.

## Queries: named reads on collections

A collection declares its reads next to its data:

```ts
const message = defineCollection({
  schema: { … },
  queries: {
    history: (messages, { thread }) => messages.find({ thread }).sort({ at: 1 }),
  },
});
```

- A query gets its collection (read-only), its params, and a context with read-only access to the
  other collections and the resources. A read across collections (threads with their last message)
  is still one query, declared on the collection it is mainly about.
- Clients call `runtime.query("message.history", { thread })`. Plugin code calls
  `ctx.db.collection("message").query("history", { thread })`.
- Queries never write.
- From outside (a host acting for a person, a browser), an actor runs only a query that lets them,
  as with Actions: `history: { allow: (actor) => actor.kind === "person", run }`. A bare function is
  the system's. Plugin code runs any query, as whom it acts for; its reads keep to the rules either
  way.

## Views: data presented to a medium

```ts
views: {
  note:    { llm: (n) => `- ${n.text}`, react: (n, ctx) => <Card>{n.text}</Card> },
  message: { llm: (m, ctx) => m.from === ctx.viewer.name ? { role: "assistant", … } : { role: "user", … } },
  thread:  { llm: agentPrompt },
}
```

- **Kind, then renderer.** A kind is a collection's name, `tool:<name>`, or a named datum (`thread`,
  `participants`). A renderer is a medium: `llm` now, `react` with the web runtime. The runtime
  treats both as names; only plugins give them meaning.
- **Composition.** `ctx.show(kind, item, hints?)` renders whatever View is registered for that kind,
  in the current renderer, or returns undefined when there is none.
- **Viewer.** `ctx.viewer` is who looks (an agent, a person). Views render relative to it: your own
  messages are the assistant's turns; for a person, your bubbles are on the right.
- **Hints.** `ctx.hints` carries what the caller asked for (`mode`: a density, such as `panel` or a
  summary line). Open-ended.
- **The last plugin wins** for a kind and renderer, so the app always has the last word. No
  resolver, no preference resources.
- **Synchronous reads.** Inside a View, reads return `{ value, status }` at once. The renderer runs
  the View again once pending reads arrive, until nothing is pending. Observed, the same function
  runs again when what it read changes, which is how a screen stays live. One authoring style for
  every medium.
- **Read-only while it renders.** A View reads, shows other Views and uses resources. Its handlers
  (a key, a click, in what it returns) call Actions (`ctx.call`) or emit events (`ctx.emit`), as any
  client does.

## The agent prompt is a View

The chat plugin's `thread` View in the `llm` renderer is the prompt layout. It returns the agent's
tools and three zones, ordered for the prompt cache (tools, then system, then messages, in every
provider):

| Zone    | Where                      | What                                                                                       |
| ------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| system  | the request's instructions | agent instructions, who is in the conversation, `system` contexts; stable, so cached       |
| history | the messages               | the thread through its lineage, each message through its View; grows at its end, so cached |
| turn    | the messages, at the end   | `turn` contexts that say something new, then kept where they were said                     |

A turn context is sent when its text isn't what the agent was last told in the conversation, and the
turn's first message keeps it (`told`, a field only trusted code reads): later turns are sent it
there, so each call starts with the whole call before it, and the provider's prompt cache keeps all
of it (OpenAI's newer models are given a breakpoint at the end of the history, as Anthropic is).

Other plugins add to it with **contexts**, the prompt layout's counterpart of a UI layout's
navigation entries. A `context` resource says where one goes; its content is a View:

```ts
resources: { context: { memory: { place: "system" } } },
views: {
  "context:memory": { llm: (thread, ctx) => notes.map((n) => ctx.show("memory", n)).join("\n") },
},
```

A context applies to every agent unless it lists `agents`. The `context` View wraps each one, tagged
as data, not instructions. The conversation itself is the `history` View (where older parts become
summaries), each message through the `message` View. `thread.prompt` (a query) and `/prompt` show
exactly what an agent gets.

## History as Views

With the `history` plugin (`resources: { history: { summarizer } }`), a processor numbers each
shared message, writes its line (`summary`, level 0) and merges completed pairs up a binary tree; a
per-thread `outline` records which lines are shown and where whole messages start. The `history`
View sends the lines (each through the `summary` View, as `id+n|text`) and then the whole messages;
the `zoom` tool opens a line. Both parts grow at their end and shrink in batches (tail 16–48 KB,
outline 64–128 KB by default), so the prompt cache holds between batches. A thread is marked
`outlined` once summarized, so others never read an outline. Forks with summaries of their own drop
their parent's part (later).

## Views are a plugin's front end

Agreed 2026-10-27. A plugin is a self-contained feature, and its Views are that feature's front end:
placed under a shell for a medium (the terminal now, the browser later), the plugins' Views render
the whole app, calling the plugins' Actions and reading their collections.

Three parts make a medium work, and the words for them:

- **A feature's front end** for the medium: its Views and commands there, in its own folder
  (`chat/terminal.ts`). A plugin.
- **The shell:** the medium's root View, which composes what's open, the scrollback and where you
  type (`terminal-shell`, the `shell` View). A plugin too: Views are run and observed by the
  runtime.
- **The host:** the program that runs the app in that medium: it observes the shell for the person
  using it, draws it with the medium's framework (Ink), and turns what they do into calls
  (`hosts/terminal`: `terminal({ runtime, me })`). Outside the runtime, through its public API only;
  it knows plugins by name (the `shell` View, `shell.set`, the `commands` resource), never by code.
  Features' front ends use the host's toolkit (`command`, `Scrollback`, `dim`) as they'd use Ink.

- **One View per medium, in the medium's own terms.** A `terminal` View returns Ink elements
  (`<Text>`, `<Box>`), or plain text; a web View will return React elements; an `llm` View returns
  text. No neutral vocabulary to learn, and no rendering of our own: the framework draws, diffs and
  lays out. What media share is everything below the View: collections, queries, Actions,
  Processors. So Views stay thin, and logic goes in queries (chat's `message.conversation`).
- **Typed per medium:** `ViewContext<Shown>` says what `ctx.show` returns there
  (`ViewContext<ReactNode>` for a terminal View).
- **A front end per feature, per medium,** in the feature's own folder: `chat/terminal.ts`
  (`chatTerminal`), `memory/terminal.ts`, `usage/terminal.ts`: their terminal Views and commands.
  Only the process that draws adds them; `chat` stays free of UI code, so executors and workers
  never load a UI framework.
- **Observed.** `runtime.observe(medium, kind, item, { viewer, hints, part })` returns a View's
  output now and again whenever a commit changes a document it read (the filter it read with is
  matched against what changed). Each View it shows is a **part** that runs again on its own, and
  keeps its output when shown again unchanged; the medium's `part` says how one goes into its
  parent's output (in Ink, a component over `useSyncExternalStore`). A part run again first asks
  again what it read last time, so it takes one pass. `runtime.idle()` waits for observed Views.
- **Actions directly; Processors for reactions.** Handlers call Actions, as on the server; a
  Processor is for something several plugins react to.
- **Live state is data.** A collection with `durable: false` lives in the owner's memory: no store,
  no events, gone on restart; in a transaction its writes apply after the store commits. Chat's
  `live` collection holds what each running turn is writing (its step's text, its tool calls),
  written at most every 50 ms and removed in the commit that writes what it became: a screen never
  shows both, or neither. No frames, no `replaces` keys, nothing held by the host.

### The terminal

- **Data** (`terminalPlugin`, every process): `shell`, one document per person: what's `open` (a
  kind and its item, such as `{ kind: "thread", item: { _id } }`) and what was `listed`, changed by
  `shell.set`; `output`, what commands printed (`durable: false`), added by `shell.print`.
- **The shell** (`terminalShell`, the drawing process): the root `shell` View composes what's open
  through its kind's View, the scrollback and the composer; `"*"` shows anything field by field.
- **The host** (`hosts/terminal`): `terminal({ runtime, me })` observes `shell` for that person and
  renders it with Ink; lines typed, piped or given run as commands; `/as` hands it to someone else.
- **Scrollback:** what's done (messages, printed output) prints once, in the order it first shows,
  into the terminal's own history (Ink's `<Static>`); what's live redraws below. Any View adds to it
  with `<Scrollback entries={[{ key, node }]} />`; keys already printed don't print again.
- **Commands** are a resource features add to (`resources.commands`), run from the composer (or from
  piped lines); they change where you are (`term.set`) and print (`term.print`, `term.show`).
- `--screen` uses the terminal's alternate screen; Ink 8 does it.

### The web

Agreed 2026-10-28.

- **Views run in the browser,** as the person: the same `observe`, its reads sent over the
  connection (one batch per pass) and answered on the server under the rules, without secret fields.
  Features bring `web.tsx` front ends (React Views), as they bring `terminal.ts`.
- **The connection is Oxian's,** the one executors use: a browser joins as an untrusted worker bound
  to its person. It signs in once (Google → a session in an httpOnly cookie), trades the cookie for
  a one-time ticket over HTTP, and presents the ticket when it connects; the host's `admit` turns it
  into the person. Every read, call and emit it makes is that person's.
- **Changes are pushed, one hop:** each read a browser's Views made is watched on the server; a
  commit that touches it re-runs it as the person, and a different result goes to the browser, which
  re-runs the parts that read it. A reply being written streams this way (`live` is a read like any
  other).
- **Where you are lives in the URL,** in the browser: two tabs show different things, links and back
  work.
- **The browser loads front-end code only** (`hosts/web`, the web shell, features' `web.tsx`), none
  of the server's resources (they hold keys); what Views need from them comes through queries.
- **Reads keep to what the person may:** a browser reads a collection directly only when a rule
  speaks for it (`find` on `message`, as its person); anything else goes through a query that lets
  the person (`allow`), whose own reads keep to the rules.
- **Writes are Actions** (`chat.send`…) for now; direct writes under the rules later.
- **Navigation is links:** Views render `<a href>`; the web host follows them (no reload) and
  observes the shell with the new path. A handler that must move on (a new conversation) calls the
  host's `go(path)`.
- **The address's parameters** reach the View it opens (`hints.query`: `/space/<id>?tab=files` is
  `{ tab: "files" }`), so a page's tab is a link too.
- **A View shown on demand** is a `LazyView`: a host component that observes a View while it's
  mounted, as the person, and closes it when it goes. What a closed panel, a folded list or an
  unchosen tab would show is never read.
- **Later:** a shard tier holds browser connections, so the owner only rings a doorbell.

### Spaces on the web

Agreed 2026-10-29: the app is organised by space, and each plugin brings its own part of it, through
resource kinds (no list of tabs or sections anywhere):

- **The sidebar** is "New chat", then the spaces you reach as a tree (Personal first): each a link
  to its page, unfolding what front ends put under it (`spaceSidebar`: chat's latest chats, and "All
  chats"), the current space and chat marked; what's folded, the browser keeps. What agents wait on
  you for in other chats shows above it, only while something does.
- **A space's page** (`/space/<id>`, spaces' `space` View) is its header (its name, renamed in place
  by managers; Personal or shared; its people; invite; a new chat there) and its tabs: `spaceTabs`
  (`{ title, view, icon?, order? }`), each a View given `{ _id }` and hints `{ in, mode: "page" }`.
  Chat adds Chats, memory Memories, computers Computer (its desks, and the terminal, jobs and files
  in its folder), spaces Members and Settings, and an app its own (the example's Notes). The address
  says which (`?tab=`). Items open full screen.
- **The side panel** belongs to the web shell (`panel: { view, on, title }`): beside a page whose
  kind it's `on` (a chat), the panel's View shows for the space you're in (`{ _id }`, hints
  `{ in, mode: "panel" }`). Spaces' fills it with the space's tabs, compact (the same Views), so a
  chat sits beside its space's files or terminal. Its button stays at the top right, and pages keep
  clear of it (`--copilotz-inset-end`); the person drags it wider; the browser keeps it open or
  closed, and its width, for them. On a phone it's a sheet. Chat knows nothing of it.
- **Archived spaces** (`space.archive`) are listed apart, under a folded "Archived" at the end of
  the tree; an archived space's page says so calmly, with Restore for its managers.
- **Invitations** to the person show at the top of the sidebar and on home (chat's `home` resource:
  Views over its greeting), to join (the space's page opens) or decline. Managers add to a space in
  one place (`space.invite`: the header's Invite dialog, a tab per kind of member): People (invite,
  see what waits, take it back), then the kinds other front ends add (spaces' `spaceInvite`
  resource: team's Agents, which a Personal space takes too). The Members tab groups members by
  kind.
- **Over where you type** (chat's `conversation` resource), Views hear `working`: true while an
  agent's turn runs in the chat, held 600 ms past its last step, so what waits for the turn to be
  over (an agent asking for your OK) comes once it is, not while the agent still explains itself.

### Agents on the web

Built 2026-10-29, on agents as space members (design/access.md): each agent works only where it's a
member, and each space has one that answers its new chats. Three front ends share it, each showing
what's its own: chat shows agents in chats, team makes and changes them, spaces adds them to spaces.

- **Members** (spaces'): a space's Agents group shows each by its emoji (or initial), the name it's
  shown as and the one it's called by (`@maya`), what it does, its role and whether it answers new
  chats (chat's `thread.agents`). Managers change its role, have it answer new chats, open it to
  edit (when they manage where it belongs) and take it out; "Add an agent" opens the invite surface
  at Agents. Settings' "Answers new chats" chooses among the agents that answer there (editors).
- **Adding one** (team's `agent.add`, the Agents tab, through spaces' `spaceInvite`): one the person
  has met that doesn't work there yet (`agent.known`), in a role, at once; or a new one, in one
  form: name, what it should do, instructions (written for them with `agent.draft` if they like, and
  undone with a press), model, tools, emoji, role, optionally starting from one of the app's agents.
  Made, it says what's next.
- **Its page** (`/agent/<id>`, team's View of kind `agent`): who it is, where it works among the
  person's spaces, what it's told and uses; "Ask" opens a new chat where it works with `@name` typed
  (`?to=`). Those who manage where it belongs edit it in place (`?edit=1`) and delete it, after a
  question that says it leaves every space it works in. The app's own agents are read only; a
  manager starts a new agent from one.
- **In a chat** (chat's): agents show as they're named, with their emoji (authors, addressees, who's
  writing, the header's faces), from `thread.agents`; names link to their pages. `@` lists the
  agents answering in the chat's space (the toolkit's `Autocomplete`, placed by script).
- **A refused message** (chat's `refusals` resource, by the refusal's code): another front end's
  View shows over the box instead of the error, with what was typed and a way to send it again.
  Spaces' `space.not-here` takes `not_here`: of the names mentioned that don't answer there (the
  composer offers them; `thread.agents` with `names` says which are agents the person meets),
  managers "Add it and send" (a viewer there is made an editor), others are told to ask one. Chat
  calls no Action of spaces': the refusal's `agents` doesn't cross the wire (only `message` and
  `code` do), so the composer passes what was typed.
- **Elsewhere:** memory's and computers' Views (who a memory is about or by, an agent asking for an
  OK, whose a job is) name agents through chat's `agentsShown`, which, in a front end (whose Views
  run without the app's `agents` and `agentSources`), asks `thread.agents`.
- **The palette** (team's `agent.palette`): agents to go to, adding one to the space, a new agent
  (where the person manages, or a space they pick), having one answer new chats, and on an agent's
  page, what to do with it. In a headed group, what can't be undone goes last, whichever front end
  gave it.

### The command palette

Built 2026-10-29. ⌘K (Ctrl+K elsewhere), or Search at the top of the sidebar, opens it over any
page; it's how the web does what the terminal's slash commands do.

- **A resource kind, filled by Views:** the web shell's `palette` resource names a View per front
  end (`{ view, order? }`), observed only while the palette is open, with hints
  `{ search, in, path, page, query }` (what's typed; where the person is; the page open,
  `{ kind, id }`). It returns groups of items as data (`PaletteGroup[]`, from `hosts/web`), not
  React: the host merges groups with the same heading (`This space` gets the spaces', computers',
  memory's and notes' items), keeps what fits what's typed, ranks it, and orders groups by `order`,
  or while searching by their best match. Each item goes somewhere (`href`, followed with `go`),
  does something (`run`: an Action through `ctx.call`; the palette shows it busy, closes when it's
  done, or says why it failed), or opens a step of its own.
- **Steps** are lists over the one before ("Move “Plan” to…", then a space), a View or items for
  what's typed (a new name), or a question (`confirm`: archive it?); Escape and Backspace go back. A
  step's `pick` is what a value chosen further on does: spaces' picker (`space.pick`, the only one)
  hands the space chosen to whatever asked (`chat.move`, `memory.move`, `note.move`,
  `computer.move`). Items' menus open the palette at such a step (`openPalette(step)`, as `go` moves
  on from anywhere), so moving looks and works the same from a menu or from ⌘K. An item may show a
  View in a dialog instead (inviting someone: `space.invite`).
- **The shell adds its own:** the side panel, home, signing out.
- **Keyboard first, and accessible:** a modal `<dialog>` (focus kept in it, given back after), its
  field a combobox over a listbox of grouped options (the active one by `aria-activedescendant`), ↑
  ↓ (Ctrl+N, Ctrl+P), Enter, Escape; results counted for screen readers. On a phone, it sits at the
  top, its rows taller, with Cancel.

### Next

- **Per-session state:** two tabs of one person shouldn't share `open`; key the shell by session
  once sessions exist (access design).
- **Edges:** an observed View that reads edges doesn't run again when they change yet.

## The design system

Agreed 2026-10-28. The web host ships a design system that Copilotz's own front ends and other apps
use, and an app rebrands as data. Its default identity is Copilotz's. Two levels of customisation,
and no more:

- **The theme, for identity:** colours, radius, fonts, logo. Most apps need only this.
- **Views, for structure:** a later plugin replaces any View (`message`, `home`), as ever. There is
  no registry for replacing components.

### Theme as data

The web host owns a token vocabulary and its defaults (`hosts/web/theme/default.ts`); an app changes
them with a `theme` resource, merged like every resource (a later plugin's patches an earlier one's;
`null` removes a token):

```ts
resources: {
  theme: {
    radius: "7px",
    font: {
      sans: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
      url: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400..800&display=swap",
    },
    logo: { mark: { viewBox: "0 0 32 32", paths: [{ d: "M8 0h16a8 8 0 0 1 8 8v16…z" }] } },
    light: { primary: "#0f766e" },
    dark: { primary: "#2dd4bf", "primary-foreground": "#042f2e" },
  },
},
```

- **The host applies it before anything is drawn,** signing in included: it merges the front ends'
  `theme` resources over the defaults itself (no connection needed; the defaults are the first
  `theme` resource, so `null` takes a default out), and writes them as CSS variables on `:root`,
  `light` ones plain and `dark` ones under `prefers-color-scheme: dark`. A theme without `dark` is
  light only. Fonts are what a theme names (`font.sans` for text, `font.display` for headings,
  `font.mono` for code), with a stylesheet that loads them (`font.url`: the host's own, Google
  Fonts', or the app's; see "Fonts" below), which the host applies. Code is set without ligatures.
- **Tokens patch; fonts and the logo are given whole.** A later theme's tokens patch an earlier
  one's one by one (a brand sets `primary` and keeps the rest), but `font` and `logo` are each the
  last one given, whole (`themeOf`): a theme that gives `font` names all its fonts (what it doesn't
  name is the system's; headings, the text's) and never inherits Copilotz's stylesheet or preloads;
  one that gives `logo` never shows its mark beside another brand's name. `null` gives none.
- **The first paint is in it too:** given the same theme (`webServer({ theme: themeOf(plugins) })`),
  the server puts its variables and the page's base in the page's head, so a dark screen is dark
  before the code loads; the host replaces that copy with its own. The head also has the page's
  icons (the theme's mark, and its PNG), the browser's colour around the page (`theme-color`: each
  scheme's `background`), and its fonts, preloaded rather than linked: the stylesheet and the files
  it lists in `font.preload` are fetched with the page, but the first paint waits on none of them,
  and the host applies the stylesheet as it starts (fonts swap in).
- **Names are shadcn's,** so shadcn themes and theme generators work as they are: `background` and
  `foreground`; `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, each
  with its `-foreground`; `border`, `input`, `ring`, `radius`; `sidebar`, `sidebar-foreground`,
  `sidebar-primary(-foreground)`, `sidebar-accent(-foreground)`, `sidebar-border`, `sidebar-ring`;
  `font-sans`, `font-mono`, `shadow-sm`, `shadow-md`, `shadow-lg`.
- **What the toolkit adds:** `font-display` (headings: page, dialog and empty-state titles, the home
  greeting, sidebar labels), `success`, `warning` and `info` (each with its `-foreground`), and
  `bubble`/`bubble-foreground` (the reader's own messages). Each colour role (`primary`,
  `destructive`, `success`, `warning`, `info`) also has `-text` (the role as text on the page),
  `-soft` (a tinted surface) and `-border` (a tinted border).
- **A brand sets `primary`; the rest follows.** Defaults derive from tokens (every role's `-text`,
  `-soft` and `-border`, `ring`, `bubble`, the sidebar's are `var()`s and `color-mix()`es of them),
  so they follow a theme unless it sets them too: a theme recolours a status by setting the status
  alone. One exception, Copilotz's own: on a light screen its focus `ring` is the logo's blue, not
  its navy, so a brand sets `ring` too for a focus in its own colour (Harbor does).
- **Radii scale with `radius`:** `--radius-xs` (½), `-sm` (⅔), `-md` (⅚), `-lg` (1), `-xl` (7⁄6),
  `-2xl` (1½), `-3xl` (2), and `--radius-full` for pills and circles. A theme with `radius: "0px"`
  is square throughout.
- **Copilotz, by default** (`hosts/web/theme/default.ts`, from the 0.x brand tokens): on a light
  screen, a navy brand (`#131b2f`: buttons, your own messages as solid bubbles) on white and cool
  slate greys, with focus in the logo's blue (`#2f87f4`); on a dark one, a deep navy page
  (`#0c101d`) and a cyan brand (`#1bdada`, with navy text on it). Manrope for text, Space Grotesk
  for headings. Every text colour is at least 4.5:1 on what it sits on, light and dark (WCAG AA),
  and the focus ring 3:1. The 0.x brand's values were the reference: its navy, cyan, blue and dark
  page as they were, its greys tuned so muted text keeps 5:1 on every surface, and Copilotz 1.0's
  own status colours (its dark red, with white on it, was 4:1; the success green is darker than the
  first one was, for white on it).
- **The logo is data:** `logo: { mark, full, icon }`. `mark` is the symbol alone (the sidebar's
  corner, home, the page's icon); `full` the mark with the name, as drawn (signing in, the sidebar;
  without it, the mark beside the app's name, in the display font); `icon` a square, opaque PNG (180
  px) for browsers without SVG icons and phones' home screens. A form is a drawing,
  `{ viewBox, paths: [{ d, fill }] }`, drawn inline by the toolkit's `Logo`, or the path of an image
  file on the app's own origin. A drawing is path data and colours only: a `fill` is a word
  (`currentColor`, the default), a hex or a colour function (`light-dark()`, `color-mix()`,
  `var()`…) over plain values, never `url()`, and anything else drops the picture (`pictureOf`):
  nothing in a logo reaches the page but paths and colours, and drawing one fetches nothing.
  Copilotz's are its real paths (`theme/copilotz.ts`): the navy "C" and name are `currentColor`, so
  they're navy on a light page and near-white on a dark one, and the inner arc's cyan (`#19F9F0`)
  and the dot's blue (`#3A8CFE`) are the brand's own in both (14:1 and 5.7:1 on the dark page).
- **The page's icon is the mark:** the server draws it as an SVG file of its own
  (`/assets/copilotz/icon.svg`, centred in a square, `currentColor` in each scheme's `foreground`,
  so it's light on a dark tab), with the theme's PNG after it. A mark that's an image file is the
  icon.
- **One resource rebrands the example:** `BRAND=harbor deno task web` serves the same app with
  `examples/terminal-agent/harbor.tsx`'s theme (a teal primary on warm stone greys, tighter corners,
  its own fonts, served by the app itself, and its own mark, a sun setting over the water, beside
  its name; its icon is that mark). `/gallery` shows the logo, the type and every component in the
  current theme.

### Fonts: the host's, Google's, or the app's own

A theme's `font.url` is a stylesheet that loads its fonts, from one of three places:

- **The host's own,** by default: Copilotz's Manrope (400 to 700) and Space Grotesk (500 to 700),
  `/assets/copilotz/fonts.css`, which `webServer` serves with no configuration, so any app that uses
  it has them, and no visitor's browser asks Google. They're data in the host
  (`hosts/web/theme/files/`: base64 modules only the server imports), not files it reads, so the
  server stays a plain `Request` handler on any runtime; each is decoded on its first request.
  Google's own files (one variable woff2 per subset, latin and latin-ext: 24, 15, 22 and 19 KB),
  with Google's stylesheet's ranges, so they render the same; a page with Latin text fetches the two
  latin ones (46 KB), preloaded, and keeps them a year. Their licences (OFL 1.1) sit beside them.

- **Google Fonts,** for convenience: `https://fonts.googleapis.com/css2?family=…`. Nothing to host;
  the page connects to `fonts.gstatic.com` early. But every visitor's browser then asks Google for
  them, which tells Google their IP address and the site they're on: under the GDPR that's personal
  data passed to a third party without consent (a Munich court awarded a visitor damages over it in
  2022).
- **The app's own,** for privacy and offline use: a path on its own origin, such as
  `/assets/fonts/harbor.css`, with the font files beside it, served by the web server. No request
  leaves the app, and the fonts work without the internet.

A theme names either; a path must start with one `/` and have no `..` (nor `%2e`, `%2f`), and no URL
may hold spaces, quotes, `<`, `>` or `\`: anything else is ignored, and the system fonts show.

**An app passes its files** to the server as data, by the path each is served at, and reads them
however its platform does; the server only answers `Request`s, so it runs on Deno, Node, Bun or a
worker:

```ts
webServer({
  runtime,
  tickets,
  script,
  upgrade,
  theme: themeOf(front),
  assets: {
    "/assets/fonts/brand.css": await Deno.readFile("fonts/brand.css"), // bytes, or text
    // Or how to read it (here Node's `fs/promises`), on the first request.
    "/assets/fonts/inter-v13-latin.woff2": () => readFile("fonts/inter-v13-latin.woff2"),
  },
});
```

- **Under `/assets/` only,** so an asset never stands in for a route or a page; a path elsewhere, or
  not a plain one (`..`, `.`, `//`, a name starting with a dot, `%`), stops the server from
  starting. Anything under `/assets/` that isn't one of them is a 404, never the page.
  `/assets/copilotz/` is the host's own (its fonts and icons): an app's asset there stops it too.
- **Exact paths, as sent:** a request is matched before `..` is resolved (Deno's `Request.url` keeps
  it), so `/assets/../app.js`, `/assets/%2e%2e/app.js` and `/assets/fonts%2fbrand.css` are 404s.
- **Known types only:** `.css` (`text/css`), `.woff2`, `.woff`, `.ttf`, `.otf` (`font/…`), `.svg`
  and `.png`. Every answer says `X-Content-Type-Options: nosniff`, and a policy under which an SVG
  opened on its own runs nothing.
- **Caching:** fonts for a year, `immutable`, so a new version takes a new name
  (`inter-v13-latin.woff2`); stylesheets and images `no-cache`, answered `304` while their `ETag`
  holds.

To self-host a Google family: ask Google's stylesheet for it (with a browser's user agent, for
woff2), keep its `latin` faces and only the weights the theme uses, download their files from
`fonts.gstatic.com`, and point `src: url(…)` at them, relative to the stylesheet; keep the family's
`OFL.txt`. Name the files every page shows at once in `font.preload` (`/assets/fonts/x.woff2`: plain
paths on the app's own origin, font files only), so they're fetched with the page rather than once
the code first draws text. Harbor's (`examples/terminal-agent/fonts/`) are Plus Jakarta Sans 400 to
800 and JetBrains Mono 400 and 600: two variable woff2 files, 27 and 31 KB, rendering the same as
Google's.

### Components

The host's toolkit (`hosts/web/toolkit/`), exported from `hosts/web/mod.ts` as the terminal host
exports `Scrollback`: plain function components whose variants are props.

- **Actions and fields:** `Button` (`primary`, `secondary`, `outline`, `ghost`, `destructive`,
  `link`; `sm`, `md`, `lg`; `icon`, `iconEnd`, `loading`; a link with `href`), `IconButton` (named
  by its `label`, shown as its tooltip), `CopyButton`, `Input` (an `icon` before, buttons `end`),
  `Textarea` (`autoGrow`, `bare`), `Field` (label, hint or error; it gives its control the id and
  descriptions), `Select` (the browser's), `Checkbox`.
- **Surfaces and labels:** `Card` (`interactive` as a button or link), `Badge` (a tone: neutral,
  primary, success, warning, destructive, info; `soft`, `outline`, `solid`), `Chip` (`soft`,
  `outline`, `primary`; a button, a link or a `<summary>`), `Avatar`, `Icon`, `Logo` (the theme's:
  the mark, or `full`, with the app's `name` as its label, `size` pixels high).
- **Overlays and navigation:** `Menu` (items as data), `Dialog`, `Drawer` (left, right, bottom),
  `Tabs` (`segmented`, `line`), `Tooltip`, `NavItem` (a row in a navigation list: an icon or
  anything leading, a count or time at its end, a description line; `current` is `page`, raised, or
  `location`, tinted).
- **Pages and details:** `Page`, a View's frame: a header (a `back` link, an `icon` or anything
  `leading`, the title, an `h1` unless given another `heading`, with `badges` after it and `actions`
  at its end, a `description`), then its content. `full` density is a page in the main area (it
  scrolls, centred at a readable `width`, and on a phone its first line keeps clear of the menu
  button); `panel` is the same View in a side panel or drawer (tighter, no margins of its own, an
  `h2`). A View says which from `ctx.hints.mode`. `DetailList`, a document's fields as label and
  value: its `item`'s fields, or the `fields` given (paths too: `tags.thread`), labelled from their
  names (`humanize`: `createdAt` is "Created") unless given a `label`, and each value formatted by
  what it is (`DetailValue`): times in words with the date on hover, Yes or No, numbers grouped, ids
  in mono with a copy button, links, long text clamped (`LongText`, "Show more"), short lists as
  chips, a document inside as a nested list, folded when big; nothing is a quiet "—". Labels sit
  beside values where there's room and stack over them where there isn't (a container query), and
  always in a `panel` `Page`. The web shell's fallback View is both: any kind without a web View of
  its own is a detail page.
- **Status and text:** `Spinner` (a ring, or dots), `Skeleton`, `EmptyState`, `Notice` (info,
  success, warning, destructive, neutral; a title, an action), `Kbd`, `Time` (relative, kept
  current; `long`, in words, for a detail page; ahead, how soon), `Markdown` (the safe subset agents
  write: links only to the web, mail or the app), `Title`.
- **Code and terminals:** `CodeBlock` (code or output in mono, on a quiet surface: a title row with
  actions, a footer; the text a string or parts in tones, `error`, `muted`, `accent`, and `added` or
  `removed` for a change line by line; folded to its first or last `lines`, or scrolling within a
  `height` that `follow`s the end; `numbers`, `copy`), and `Terminal`, xterm.js over a session that
  runs a line at a time (not a PTY): a prompt, a shell's line editing and history, Enter runs,
  Ctrl+C interrupts, output as it comes; its colours are the theme's tokens, resolved where it
  shows, light and dark. xterm.js, its fit addon and its stylesheet (vendored with the theme's
  colours, `xterm-style.ts`) load with a dynamic `import()` the first time a terminal shows, in
  chunks of their own, as Temml does for math. `bytes` says sizes ("4.2 KB").
- **Sound:** `AudioPlayer` (play and pause, its waveform as the progress bar, its length; one plays
  at a time; on a `card`, `muted`, `bubble` or `bare` surface, with what goes beneath it, a
  transcript, as its children), `Waveform` (peaks as bars, as many as fit; a slider that seeks by
  click, drag or arrow keys; `live` for levels as they come), `clock` (`0:07`) and `resample`. Chat
  records voice messages with them (`MediaRecorder`: Opus in WebM, else AAC in MP4), and plays what
  was sent from `/files/<id>`, which answers ranges, as Safari needs.

**Behaviour is the platform's,** with no dependencies: `Dialog` and `Drawer` are the modal
`<dialog>` (`showModal`: the page behind inert, focus kept inside and given back, Escape and the
backdrop close it); `Menu` and `Tooltip` are popovers in the top layer, placed by CSS anchor
positioning, or by script where the browser hasn't it; `Menu` and `Tabs` move by arrow keys, Home
and End (roving focus: one tab stop), and Escape gives focus back to the menu's button. On a phone
the shell's sidebar is a `Drawer`.

**Styles are CSS in TypeScript strings,** each component's beside it, hoisted into the page once by
React 19 (`<style href precedence>`), so they work from JSR and npm with no build step: no Tailwind,
no Radix, no class-variance helper. Three layers, in order: the page's base (reset, type, focus
rings), the toolkit's pieces, then front ends' own CSS, which is in no layer and so always wins: a
plugin lays a piece out (`.chat-jump { position: absolute }`) without fighting it.

### Plugins compose; they don't style

A front end builds from the toolkit, and its own CSS is only its layout (grids, gaps, sizes, where
things sit), on the theme's variables. `testing/styles.test.ts` keeps it so: in plugin code
(stylesheet strings, `style={{…}}`, SVG paint) it fails on colour literals (hex, `rgb()`, `hsl()`,
`oklch()`…, and named colours in properties that paint), on shadows that aren't each a
`var(--shadow-…)`, and on radii that aren't `0` or a `var(--radius-…)` (or a `calc()` over one). It
allows `var(--…)`, `color-mix()` over variables, `transparent`, `currentColor` and `inherit`;
comments, and a plugin's own `resources/theme.ts`, are skipped. A ring that would be a shadow is an
`outline`; an overlap ring (stacked avatars) too.
