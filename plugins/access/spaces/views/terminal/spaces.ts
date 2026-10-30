/** Spaces in a numbered list: name, kind, id; ● marks where you work. */
import { accent, dim } from "../../../../../hosts/terminal/mod.ts";

type Space = { _id: string; name: string; kind: string };

export const spacesView = (l: { spaces: Space[]; here?: string }): string =>
  l.spaces.map((s, i) =>
    `${dim(`[${i + 1}]`)} ${s.name} ${dim(`· ${s.kind} · ${s._id}`)}${
      s._id === l.here ? accent(" ●") : ""
    }`
  ).join("\n");
