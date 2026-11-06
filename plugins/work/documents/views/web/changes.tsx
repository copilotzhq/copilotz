/**
 * A change, as people read it: the lines taken out and put in, in the
 * toolkit's `CodeBlock` tones (− removed, + added), with a few lines of
 * what stayed around each and the rest folded ("12 unchanged lines").
 */
import type { ReactNode } from "react";
import { CodeBlock, type CodePart } from "../../../../../hosts/web/mod.ts";
import { counted, diffLines, linesOf } from "../../shared/diff.ts";

/** The change from `before` to `after`, as a code block's parts, `context` lines around each. */
export function diffParts(before: string, after: string, context = 3): CodePart[] {
  const edits = diffLines(before ? linesOf(before) : [], after ? linesOf(after) : []);
  const parts: CodePart[] = [];
  const line = (text: string, tone?: CodePart["tone"]) => {
    if (parts.length) parts.push({ text: "\n" });
    // Lines that stayed line up with the changed ones, past where their + and − go.
    parts.push(
      tone === "added" || tone === "removed" ? { text, tone } : {
        text: `  ${text}`,
        ...(tone ? { tone } : {}),
      },
    );
  };
  let i = 0;
  while (i < edits.length) {
    const e = edits[i];
    if (e.kind !== "same") {
      line(e.text, e.kind);
      i++;
      continue;
    }
    let j = i;
    while (j < edits.length && edits[j].kind === "same") j++;
    const head = i === 0 ? 0 : context;
    const tail = j === edits.length ? 0 : context;
    if (j - i > head + tail + 1) {
      for (let k = i; k < i + head; k++) line(edits[k].text);
      const folded = j - i - head - tail;
      line(`⋯ ${folded} unchanged line${folded === 1 ? "" : "s"}`, "muted");
      for (let k = j - tail; k < j; k++) line(edits[k].text);
    } else {
      for (let k = i; k < j; k++) line(edits[k].text);
    }
    i = j;
  }
  return parts;
}

/** "+12 −3", in the tones of what was added and removed. */
export function Counts({ added, removed }: { added: number; removed: number }): ReactNode {
  return (
    <span className="doc-counts" aria-label={`${added} lines added, ${removed} removed`}>
      <span className="doc-added">+{added}</span>
      <span className="doc-removed">−{removed}</span>
    </span>
  );
}

/** The change from `before` to `after`, in a code block titled `title`. */
export function Diff(
  { before, after, title, empty = "No changes to the text.", height }: {
    before: string;
    after: string;
    title?: ReactNode;
    empty?: string;
    height?: number;
  },
): ReactNode {
  const parts = before === after ? [] : diffParts(before, after);
  const { added, removed } = before === after
    ? { added: 0, removed: 0 }
    : counted(diffLines(before ? linesOf(before) : [], after ? linesOf(after) : []));
  return (
    <CodeBlock
      className="doc-diff"
      title={title}
      actions={before === after || !title ? undefined : <Counts added={added} removed={removed} />}
      code={parts}
      empty={empty}
      label={typeof title === "string" ? title : "The changes"}
      {...(height ? { height } : {})}
    />
  );
}
