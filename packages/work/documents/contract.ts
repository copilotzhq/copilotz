/**
 * The documents plugin's contract: what other code may import, on either
 * side: the shapes of a document (`Document`; as a list shows it,
 * `Listed`), of each version (`DocumentVersion`; as History lists it,
 * `Saved`) and of who has one open (`Presence`), and its addresses
 * (`documentPath`, `documentsTab`) and limits. The rest is reached by name:
 * its collections (`document`, `documentVersion`, `documentPresence`), its
 * queries (`document.list`, `document.recent`, `documentVersion.history`),
 * its Actions (`document.create`, `document.save`, `document.rename`,
 * `document.delete`, `document.restore`, `document.presence`) and its
 * tools (`list_documents`, `read_document`, `write_document`,
 * `append_document`, `edit_document`).
 */
export type { Document, Listed } from "./collections/document.ts";
export type { DocumentVersion, Saved } from "./collections/document-version.ts";
export type { Presence } from "./collections/document-presence.ts";
export { documentPath, documentsTab, LIMIT, TITLE } from "./shared/text.ts";
