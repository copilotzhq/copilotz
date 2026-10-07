/** Reasoning markup is a provider output dialect, never an input format. */
const TAGS = ["think", "thought", "thinking", "reasoning"].flatMap((
  tag,
) => [tag, `mm:${tag}`]);
export function isReasoningTag(tag: string): boolean {
  return TAGS.includes(tag.toLowerCase());
}

/**
 * Incremental output-only extraction. Markdown code, block quotes and quoted
 * strings are literal content. Keep only a possible delimiter between chunks,
 * so extraction remains linear even for very large provider responses.
 */
export function createReasoningOutputReader() {
  let pending = "";
  let hidden: string | undefined;
  let code: { char: string; length: number } | undefined;
  let codeRun: { char: string; length: number; lineStart: boolean } | undefined;
  let openingTag: { name: string; closing: boolean; last: string } | undefined;
  let fenced = false;
  let quote: string | undefined;
  let escaped = false;
  let lineStart = true;
  let quotedLine = false;
  let previous = "";
  return {
    write(
      input: string,
      final = false,
    ): { visible: string; reasoning: string } {
      const text = pending + input;
      pending = "";
      let visible = "";
      let reasoning = "";
      let i = 0;
      const emit = (value: string) => {
        visible += value;
        previous = value.at(-1) ?? previous;
        for (const char of value) {
          if (char === "\n") {
            lineStart = true;
            quotedLine = false;
            quote = undefined;
          } else if (char !== " " && char !== "\t" && char !== "\r") {
            lineStart = false;
          }
        }
      };
      while (i < text.length) {
        if (openingTag) {
          const end = text.indexOf(">", i);
          const header = text.slice(i, end < 0 ? text.length : end).trimEnd();
          if (header) openingTag.last = header.at(-1)!;
          if (end < 0) break;
          if (!openingTag.closing && openingTag.last !== "/") {
            hidden = openingTag.name;
          }
          openingTag = undefined;
          i = end + 1;
          continue;
        }
        if (hidden) {
          const close = `</${hidden}>`;
          const remaining = text.slice(i);
          const end = remaining.toLowerCase().indexOf(close);
          if (end >= 0) {
            reasoning += remaining.slice(0, end);
            i += end + close.length;
            hidden = undefined;
            continue;
          }
          let overlap = 0;
          if (!final) {
            const lower = remaining.toLowerCase();
            for (let n = 1; n < close.length && n <= lower.length; n++) {
              if (lower.endsWith(close.slice(0, n))) overlap = n;
            }
          }
          reasoning += remaining.slice(0, remaining.length - overlap);
          pending = remaining.slice(remaining.length - overlap);
          break;
        }
        const char = text[i];
        if (quotedLine) {
          emit(char);
          i++;
          continue;
        }
        if (quote) {
          const closes = char === quote && !escaped;
          escaped = char === "\\" && !escaped;
          emit(char);
          i++;
          if (closes) quote = undefined;
          continue;
        }
        if (
          codeRun || char === "`" ||
          (char === "~" && (lineStart || code?.char === "~"))
        ) {
          codeRun ??= { char, length: 0, lineStart };
          let end = i;
          while (text[end] === codeRun.char) end++;
          codeRun.length += end - i;
          emit(text.slice(i, end));
          i = end;
          if (end === text.length && !final) break;
          const run = codeRun;
          codeRun = undefined;
          if (code) {
            if (
              run.char === code.char &&
              (fenced
                ? run.lineStart && run.length >= code.length
                : run.length === code.length)
            ) code = undefined;
          } else if (run.char === "`" || run.length >= 3) {
            code = { char: run.char, length: run.length };
            fenced = run.lineStart && run.length >= 3;
          }
          if (end === text.length) break;
          continue;
        }
        if (code) {
          emit(char);
          i++;
          continue;
        }
        if (lineStart && char === ">") quotedLine = true;
        if (char === '"' || char === "'") {
          // Apostrophes inside words are not quotation delimiters.
          if (char === '"' || !previous || /[\s([{=:]/.test(previous)) {
            quote = char;
            escaped = false;
          }
        }
        if (char === "<") {
          // Recognition only needs the longest name plus a boundary character.
          // Scanning the whole remainder at every ordinary HTML '<' is quadratic.
          const tail = text.slice(i, i + 17);
          const lower = tail.toLowerCase();
          const match =
            /^<\/?((?:mm:)?(?:think|thought|thinking|reasoning))(?=[\s/>]|$)/i
              .exec(tail);
          const partial = TAGS.some((tag) =>
            `<${tag}`.startsWith(lower) || `</${tag}`.startsWith(lower)
          );
          if (match || partial) {
            const end = text.indexOf(">", i);
            if (end < 0 && !final) {
              // Once whitespace/attributes establish a tag, consume its header
              // incrementally; never retain an arbitrarily long partial tag.
              if (match && tail.length > match[0].length) {
                openingTag = {
                  name: match[1].toLowerCase(),
                  closing: tail.startsWith("</"),
                  last: "",
                };
                i += match[0].length;
                continue;
              }
              pending = text.slice(i);
              break;
            }
            if (match) {
              if (
                !tail.startsWith("</") &&
                !/\/\s*>$/.test(text.slice(i, end + 1))
              ) hidden = match[1].toLowerCase();
              i = end < 0 ? text.length : end + 1;
              continue;
            }
          }
        }
        emit(char);
        i++;
      }
      return { visible, reasoning };
    },
  };
}

export function extractReasoningOutput(
  text: string,
): { visible: string; reasoning: string } {
  return createReasoningOutputReader().write(text, true);
}
