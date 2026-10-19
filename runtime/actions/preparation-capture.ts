/** Private provenance for an input retained by the existing child Action
 * lifecycle. These facts establish no authority on their own: every use must
 * reauthorize the original source, audience, content and resource identities. */
import { assertJsonValue } from "../json.ts";
import { viewShowsKey } from "../views/definition.ts";
import type { ViewShows } from "../views/definition.ts";
import type { PreparedViewSelection } from "../views/preparation.ts";

export const ACTION_PREPARATION_SCHEMA = "copilotz.action.preparation.v1";
export type PreparationContentReference = Readonly<{
  ref: Readonly<{
    assetId: string;
    kind: "text" | "json";
    role: string;
    mediaType: string;
  }>;
  version: Readonly<{ byteLength: number; digest: string }>;
}>;
export type PreparationSourceReference = Readonly<{
  source: Readonly<
    & {
      name: string;
      kind: string;
      recordId: string;
      namespace: string;
      /** Digest of the original authorized projection, never the raw record. */
      digest: string;
      fields: readonly string[];
    }
    & ({ path: string } | {
      selection: "record";
    })
  >;
  audience: string;
  content: readonly PreparationContentReference[];
}>;
export type PreparationResourceReference = Readonly<{
  namespace: string;
  alias: string;
  /** Digest of the original authorized ordinary resource projection only. */
  digest: string;
}>;
export type ActionPreparationCapture = Readonly<{
  schema: typeof ACTION_PREPARATION_SCHEMA;
  preparation: string;
  source: PreparationSourceReference;
  resources: readonly PreparationResourceReference[];
  view: Readonly<{
    shows: ViewShows;
    hints: Readonly<{ mode: string; renderer: "text" }>;
    selection: PreparedViewSelection;
  }>;
}>;
function invalid(): never {
  throw Object.assign(new Error("preparation_capture_invalid"), {
    code: "preparation_capture_invalid",
  });
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) invalid();
  return data;
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 512 ||
    [...value].some((character) =>
      character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
    )
  ) invalid();
}
function digest(value: unknown): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    invalid();
  }
}
function detached(value: unknown): unknown {
  try {
    assertJsonValue(value, { maxDepth: 16, maxNodes: 5000 });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536) {
      invalid();
    }
    return structuredClone(value);
  } catch {
    invalid();
  }
}
/** Strict source facts parser shared by fresh capture and original-ref checks.
 * It never accepts physical locators or hydrated values. */
export function parsePreparationSourceReference(
  value: unknown,
): PreparationSourceReference {
  const data = exact(detached(value), ["source", "audience", "content"]);
  const record = !!data.source && typeof data.source === "object" &&
    Object.hasOwn(data.source, "selection");
  const source = exact(data.source, [
    "name",
    "kind",
    record ? "selection" : "path",
    "recordId",
    "namespace",
    "digest",
    "fields",
  ]);
  if (record && source.selection !== "record") invalid();
  for (const key of ["name", "kind", "recordId", "namespace"]) {
    text(source[key]);
  }
  if (!record) text(source.path);
  digest(source.digest);
  if (
    !Array.isArray(source.fields) || source.fields.length > 128 ||
    new Set(source.fields).size !== source.fields.length
  ) invalid();
  source.fields.forEach((field: unknown) => {
    text(field);
    if (
      typeof field !== "string" || !field.startsWith("/") ||
      /~(?:[^01]|$)/.test(field) || field.slice(1).split("/").some((part) =>
        !part ||
        ["__proto__", "prototype", "constructor"].includes(
          part.replaceAll("~1", "/").replaceAll("~0", "~"),
        )
      )
    ) {
      invalid();
    }
  });
  if (
    source.fields.some((a: string) =>
      (source.fields as string[]).some((b) => a !== b && b.startsWith(`${a}/`))
    )
  ) invalid();
  text(data.audience);
  if (
    !Array.isArray(data.content) || data.content.length > 100 ||
    (record && data.content.length !== 0)
  ) invalid();
  let bytes = 0;
  for (const value of data.content) {
    const item = exact(value, ["ref", "version"]);
    const ref = exact(item.ref, ["assetId", "kind", "role", "mediaType"]);
    for (const value of Object.values(ref)) text(value);
    if (ref.kind !== "text" && ref.kind !== "json") invalid();
    const version = exact(item.version, ["byteLength", "digest"]);
    if (
      !Number.isSafeInteger(version.byteLength) ||
      Number(version.byteLength) < 0
    ) invalid();
    digest(version.digest);
    bytes += Number(version.byteLength);
    if (bytes > 1_048_576) invalid();
  }
  return data as PreparationSourceReference;
}
export function parseActionPreparationCapture(
  value: unknown,
): ActionPreparationCapture {
  const data = exact(detached(value), [
    "schema",
    "preparation",
    "source",
    "resources",
    "view",
  ]);
  if (data.schema !== ACTION_PREPARATION_SCHEMA) invalid();
  text(data.preparation);
  parsePreparationSourceReference(data.source);
  if (!Array.isArray(data.resources) || data.resources.length > 32) invalid();
  const seen = new Set<string>();
  for (const value of data.resources) {
    const resource = exact(value, ["namespace", "alias", "digest"]);
    text(resource.namespace);
    text(resource.alias);
    digest(resource.digest);
    const key = JSON.stringify([resource.namespace, resource.alias]);
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  const view = exact(data.view, ["shows", "hints", "selection"]);
  try {
    viewShowsKey(view.shows as ViewShows);
  } catch {
    invalid();
  }
  text(
    typeof view.shows === "string"
      ? view.shows
      : Object.values(view.shows as object)[0],
  );
  const hints = exact(view.hints, ["mode", "renderer"]);
  text(hints.mode);
  if (hints.renderer !== "text") invalid();
  const selection = view.selection as { kind?: unknown } | null;
  if (selection?.kind === "generic") exact(selection, ["kind"]);
  else if (selection?.kind === "registered") {
    text(exact(selection, ["kind", "id"]).id);
  } else invalid();
  return data as ActionPreparationCapture;
}
