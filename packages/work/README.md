# @copilotz/work

Kanban boards and shared Markdown documents, in a space, for people and agents: two plugins for
[Copilotz](https://github.com/copilotzhq/copilotz), beside its `chat` and `spaces`.

```sh
npm install @copilotz/work copilotz          # Node 24+, Bun
deno add jsr:@copilotz/work jsr:@copilotz/copilotz
```

It goes with Copilotz at the same version (they're released together): `@copilotz/work@x.y.z` with
`copilotz@x.y.z`.

```ts
import { createRuntime } from "copilotz";
import { models } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { access } from "copilotz/plugins/access";
import { boards, documents } from "@copilotz/work";

const runtime = await createRuntime({
  store,
  plugins: [models, chat, ...access, boards, documents, app],
});
```

```ts
// In the browser, beside the web shell's front ends:
import { boardsWeb, documentsWeb } from "@copilotz/work/web";

await web({ plugins: [webShell, chatWeb, spacesWeb, boardsWeb, documentsWeb], root });
```

| Import                    | What it has                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `@copilotz/work`          | `boards` (kanban), `documents` (shared Markdown with versions and merges)            |
| `@copilotz/work/web`      | `boardsWeb`, `documentsWeb`: a space's Board and Documents tabs, their pages         |
| `@copilotz/work/contract` | their shapes (`Board`, `Card`, `Document`…) and addresses, for plugins built on them |

Both live in spaces (read where the space is read, changed where it's written), change only through
their Actions, and give agents tools wherever a conversation is in a space.

- **Boards** are kanban: columns in order (a new one starts with Backlog, To do, Doing, Blocked, In
  review and Done), cards dragged within and across them, owners, labels and due dates. Its
  collections are `board` and `card`; its tools, `list_boards`, `read_board`, `create_board`,
  `create_card`, `update_card` and `move_card`. The app words the one line about agents on an empty
  Board tab (`boardsText: { agentHint: "…" }`, a resource).
- **Documents** are Markdown where every save is a version (who, what, when), a save that started
  from an old version is merged line by line or refused as a `conflict` for the person to settle, an
  old version comes back as a new one, and who has one open is live. Its collections are `document`,
  `documentVersion` and `documentPresence`; its tools, `list_documents`, `read_document`,
  `write_document`, `append_document` and `edit_document`.

Through 1.0.0-rc.32 these were `copilotz/plugins/work` and `copilotz/plugins/work/web`. Their names
(collections, Actions, events, Views, resources) are the same, so an app's data stays as it is: only
its imports change. See
[design/plugins.md](https://github.com/copilotzhq/copilotz/blob/main/design/plugins.md).
