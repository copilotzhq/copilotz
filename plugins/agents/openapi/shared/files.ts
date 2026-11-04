/**
 * Files in a response, kept out of the prompt: each configured field holding
 * a data URL or base64 (and a response that is a file, which comes back as a
 * data URL) becomes a `file` document of the conversation (chat's), and the
 * agent is given a reference to it. Their type and size are checked first.
 * The document's id comes from the conversation, the operation and the
 * content, so a tool run again saves nothing twice.
 */
import type { OpenApiFile } from "../contract.ts";
import type { ToolContext } from "../../chat/contract.ts";
import { type Settings, sized } from "./settings.ts";

type Slot = { holder: Record<string | number, unknown>; key: string | number; at: string };
type Found = Slot & { type: string; data: string; size: number };

const extension = (type: string) => (type.split("/")[1] ?? "").replace(/[^a-z0-9]+/g, "") || "bin";
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "text/plain": "txt",
  "audio/mpeg": "mp3",
  "application/octet-stream": "bin",
};

/** Where a field path (`data.*.image`) leads in a value: each place holding something. */
function slots(value: unknown, path: string[], at: string[] = []): Slot[] {
  const [head, ...rest] = path;
  if (head === undefined || !value || typeof value !== "object") return [];
  const holder = value as Record<string | number, unknown>;
  const keys = head !== "*"
    ? [head]
    : Array.isArray(value)
    ? value.map((_, i) => i)
    : Object.keys(value);
  return keys.flatMap((key) => {
    const here = [...at, String(key)];
    if (rest.length) return slots(holder[key], rest, here);
    return holder[key] === undefined || holder[key] === null
      ? []
      : [{ holder, key, at: here.join(".") }];
  });
}

/** Its media type, from the first bytes: images and PDFs. */
function sniff(data: string): string {
  let head = "";
  try {
    head = atob(data.slice(0, 16));
  } catch {
    return "application/octet-stream";
  }
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.startsWith("%PDF")) return "application/pdf";
  return "application/octet-stream";
}

/** A field's value as a file: a data URL, or base64 whose type its bytes tell. */
function decoded(value: unknown, at: string): { type: string; data: string; size: number } {
  if (typeof value !== "string") throw new Error(`The response's "${at}" isn't a file`);
  const url = /^data:([^,]*),/i.exec(value);
  if (url && !/;base64$/i.test(url[1])) {
    throw new Error(`The response's "${at}" is a data URL, but not base64`);
  }
  const raw = (url ? value.slice(url[0].length) : value).replace(/\s+/g, "")
    .replace(/-/g, "+").replace(/_/g, "/");
  const data = raw.padEnd(raw.length + (4 - raw.length % 4) % 4, "=");
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error(`The response's "${at}" isn't a data URL or base64`);
  }
  const type = url ? url[1].split(";")[0].trim().toLowerCase() || "text/plain" : sniff(data);
  const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  return { type, data, size };
}

const allowed = (type: string, types: string[]) =>
  types.some((t) => t === type || (t.endsWith("/*") && type.startsWith(t.slice(0, -1))));

async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(hash.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The result with its files saved and referenced, each named for its operation (`getMap.png`). */
export async function withFiles(
  ctx: ToolContext,
  settings: Settings,
  operation: string,
  result: unknown,
): Promise<unknown> {
  const fields = settings.files?.[operation] ?? [];
  // A response that was a file is one, whole (a data URL, as the Action gives it back).
  const whole = typeof result === "string" && /^data:[\w.+-]+\/[\w.+-]+;base64,/i.test(result);
  if (!whole && !fields.length) return result;
  const copy = { result: whole ? result : structuredClone(result) };
  const places = whole
    ? [{ holder: copy, key: "result", at: "response" } as Slot]
    : fields.flatMap((field) => slots(copy.result, field.split("."), []));
  if (!places.length) return copy.result;

  let total = 0;
  const found: Found[] = places.map((slot) => {
    const file = decoded(slot.holder[slot.key], slot.at);
    if (!allowed(file.type, settings.fileTypes)) {
      throw new Error(
        `The response's "${slot.at}" is a file of type ${file.type}, which isn't one this API ` +
          "may return (its fileTypes)",
      );
    }
    total += file.size;
    if (total > settings.maxFileBytes) {
      throw new Error(
        `The response's files are larger than ${sized(settings.maxFileBytes)} (its maxFileBytes)`,
      );
    }
    return { ...slot, ...file };
  });

  if (!ctx.thread) throw new Error("A file from an API is kept in a conversation: there's none");
  const thread = await ctx.db.collection<{ in?: string }>("thread").findOne({ _id: ctx.thread });
  const files = ctx.db.collection("file");
  const refs = new Map<string, OpenApiFile>();
  for (const f of found) {
    // The same content from the same operation, in this conversation, is the same file.
    const id = `${ctx.thread}:file.${await digest(`${operation}:${f.type}:${f.data}`)}`;
    if (!refs.has(id)) {
      const name = `${operation}.${EXTENSIONS[f.type] ?? extension(f.type)}`;
      if (!await files.countDocuments({ _id: id })) {
        // Two calls running together may both save it: the same document either way.
        await files.replaceOne({ _id: id }, {
          name,
          type: f.type,
          size: f.size,
          data: f.data,
          thread: ctx.thread,
          ...(thread?.in ? { in: thread.in } : {}),
          at: new Date().toISOString(),
        }, { upsert: true });
      }
      refs.set(id, { file: id, name, type: f.type, size: f.size });
    }
    f.holder[f.key] = refs.get(id);
  }
  return copy.result;
}
