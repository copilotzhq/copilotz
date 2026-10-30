/**
 * Files with messages, as one model reads them. A file goes as it is when the
 * model reads its kind (models.dev's input modalities, or the model choice's
 * `input` for one the catalog doesn't know) and its adapter can send it; the
 * latest go first, up to `FILES.count`. Any other stays out, and its message
 * says so: the text already names the file, so the model knows it's there.
 */
import type { Media } from "./choice.ts";
import type { LlmFile, LlmMessage } from "./types.ts";

/** The most files one call carries (the latest), and the largest one (base64 characters, ~10 MB). */
export const FILES = { count: 8, chars: 14_000_000 };

/** What kind of input a file is to a model, if any it might read. */
export function mediumOf(type: string): Media | undefined {
  if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  return undefined;
}

/** Why a file isn't shown, in a line the model reads. */
const left = (file: LlmFile, why: string) => `[${file.name} isn't shown: ${why}]`;

/** The messages for a model that reads `media`: its files kept or named as left out. */
export function filesFor(media: Media[], messages: LlmMessage[]): LlmMessage[] {
  let room = FILES.count;
  const out = messages.toReversed().map((message): LlmMessage => {
    if (message.role !== "user" || !message.files?.length) return message;
    const kept: LlmFile[] = [];
    const notes: string[] = [];
    for (const file of message.files) {
      const medium = mediumOf(file.type);
      if (!medium || !media.includes(medium)) {
        notes.push(left(file, `this model can't read ${medium ?? file.type} files`));
      } else if (file.data.length > FILES.chars) notes.push(left(file, "it's too large"));
      else if (room <= 0) notes.push(left(file, "older files aren't sent again"));
      else {
        kept.push(file);
        room--;
      }
    }
    const { files: _, ...rest } = message;
    return {
      ...rest,
      text: notes.length ? `${message.text}\n${notes.join("\n")}` : message.text,
      ...(kept.length ? { files: kept.toReversed() } : {}),
    };
  });
  return out.toReversed();
}
