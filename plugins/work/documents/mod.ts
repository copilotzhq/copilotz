/**
 * Documents: shared Markdown in a space, for people and agents — the
 * canonical artifact of the thing being made, and its working memory.
 *
 * - **Every save is a version** (`documentVersion`): who changed what and
 *   when, and how many lines; an old one comes back as a new one
 *   (`document.restore`).
 * - **Two at once:** a save says the version it started from (`base`). If
 *   someone saved since, the changes are merged line by line against it:
 *   saved together where they touch different lines, refused with
 *   `conflict` where they touch the same ones, for the person to settle.
 * - **Before it happens:** who has a document open, and who's editing it,
 *   is live (`documentPresence`, kept in memory only), on its page.
 * - **People's Actions:** `document.create`, `document.save`,
 *   `document.rename`, `document.delete`, `document.restore`, and
 *   `document.presence` (open, editing, gone).
 * - **Agents' tools,** wherever a conversation is in a space:
 *   `list_documents`, `read_document`, `write_document`,
 *   `append_document`, `edit_document`. Each change reads and writes in one
 *   transaction, so agents never conflict, and it's a version like any.
 * - **Shared in spaces** (spaces' `shared` resource): the access plugin's
 *   rules keep every read and write to what the actor reaches; a viewer
 *   reads, an editor writes, and anyone who reads a document may say
 *   they're there. Nothing outside writes them directly (the REST API, a
 *   browser's socket): only the Actions keep every save a version, by whom
 *   it was.
 *
 * Its front end is `documentsWeb` (web.tsx); what other code may import,
 * contract.ts.
 *
 * ```ts
 * plugins: [models, chat, ...access, documents]
 * ```
 */
import { definePlugin, failure, type Plugin } from "../../../runtime/mod.ts";
import { createAction } from "./actions/create.ts";
import { deleteAction } from "./actions/delete.ts";
import { presenceAction } from "./actions/presence.ts";
import { renameAction } from "./actions/rename.ts";
import { restoreAction } from "./actions/restore.ts";
import { saveAction } from "./actions/save.ts";
import { document } from "./collections/document.ts";
import { documentPresence } from "./collections/document-presence.ts";
import { documentVersion } from "./collections/document-version.ts";
import { tools } from "./resources/tools.ts";

export * from "./contract.ts";

/** Its collections. */
const OWN = ["document", "documentVersion", "documentPresence"];

export const documents: Plugin = definePlugin({
  name: "documents",
  requires: ["chat", "spaces"],
  collections: { document, documentVersion, documentPresence },
  actions: {
    "document.create": createAction,
    "document.save": saveAction,
    "document.rename": renameAction,
    "document.delete": deleteAction,
    "document.restore": restoreAction,
    "document.presence": presenceAction,
  },
  resources: {
    // In spaces: read where the space is read, changed where it's written; presence, where read.
    shared: { document: {}, documentVersion: {}, documentPresence: { write: "read" } },
    tools,
  },
  // Only the Actions change them: a write from outside (`direct`) would be a save with no
  // version, a version by someone else, or someone else's presence.
  guard: (_actor, { collection, access, direct }) => {
    if (OWN.includes(collection) && direct && access === "write") {
      throw failure("forbidden", "Documents change through their Actions.", { public: true });
    }
    return undefined;
  },
});

export default documents;
