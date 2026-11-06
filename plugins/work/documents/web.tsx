/**
 * Documents' web front end, for the browser: a space's Documents tab
 * (spaces' `spaceTabs`: its documents, a new one in a click, and, beside a
 * chat, the same compact, a document opening there to read), a document's
 * page (`/document/<id>`: the title in place, a Markdown editor with
 * Write / Preview / Split, ⌘S saving each version, a draft kept in the
 * browser, who else is in it, the conflict screen when two saves clash, and
 * History in a drawer: every version, its changes, restoring one), the
 * command palette's (the web shell's `palette`: going to a document, a new
 * one here, and what to do with the one open), and agents' calls to the
 * documents tools in a conversation, as compact cards (chat's `toolViews`).
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, documentsWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { historyView, versionView } from "./views/web/history.tsx";
import { documentsView, readView } from "./views/web/list.tsx";
import { documentView } from "./views/web/page.tsx";
import { documentsPaletteView } from "./views/web/palette.tsx";
import { documentStepView } from "./views/web/step.tsx";

export const documentsWeb: Plugin = definePlugin({
  name: "documents-web",
  requires: ["web-shell"],
  views: {
    documents: documentsView,
    document: documentView,
    "document.read": readView,
    "document.history": historyView,
    "document.version": versionView,
    "document.palette": documentsPaletteView,
    "document.step": documentStepView,
  },
  resources: {
    spaceTabs: { documents: { title: "Documents", view: "documents", icon: "file", order: 30 } },
    palette: { documents: { view: "document.palette", order: 32 } },
    toolViews: {
      list_documents: "document.step",
      read_document: "document.step",
      write_document: "document.step",
      append_document: "document.step",
      edit_document: "document.step",
    },
  },
});
