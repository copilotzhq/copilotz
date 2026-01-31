
// Robust SQL statement splitter:
// - Respects dollar-quoted blocks (DO $$...$$; or $tag$...$tag$;)
// - Ignores semicolons inside single/double quotes and comments
// - Keeps statements intact so control blocks don't get torn apart
export function splitSQLStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null; // like $$ or $func$

  const flush = () => {
    const s = current.trim();
    if (s.length > 0) {
      // Strip leading single-line comments for each statement
      const lines = s.split("\n");
      while (lines.length > 0 && lines[0].trim().startsWith("--")) {
        lines.shift();
      }
      const cleaned = lines.join("\n").trim();
      if (cleaned.length > 0) {
        statements.push(cleaned);
      }
    }
    current = "";
  };

  const isDollarStartAt = (str: string, idx: number): string | null => {
    // Detect $$ or $word$
    if (str[idx] !== "$") return null;
    // $$ (no tag)
    if (str[idx] === "$" && str[idx + 1] === "$") return "$$";
    // $tag$
    let j = idx + 1;
    if (!/[A-Za-z0-9_]/.test(str[j] || "")) return null;
    while (j < str.length && /[A-Za-z0-9_]/.test(str[j]!)) j++;
    if (str[j] === "$") {
      return str.slice(idx, j + 1); // $tag$
    }
    return null;
  };

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1]!;

    // Handle line comments //
    if (!inSingleQuote && !inDoubleQuote && !inBlockComment && !dollarTag && ch === "-" && next === "-") {
      inLineComment = true;
    }
    if (inLineComment && ch === "\n") {
      inLineComment = false;
    }
    if (inLineComment) {
      current += ch;
      continue;
    }

    // Handle block comments /* ... */
    if (!inSingleQuote && !inDoubleQuote && !inBlockComment && !dollarTag && ch === "/" && next === "*") {
      inBlockComment = true;
    } else if (inBlockComment && ch === "*" && next === "/") {
      inBlockComment = false;
      current += "*/";
      i++; // consume '/'
      continue;
    }
    if (inBlockComment) {
      current += ch;
      continue;
    }

    // Handle dollar-quoted blocks
    if (!inSingleQuote && !inDoubleQuote && !dollarTag) {
      const tag = isDollarStartAt(sql, i);
      if (tag) {
        dollarTag = tag;
        current += tag;
        i += tag.length - 1;
        continue;
      }
    } else if (dollarTag) {
      // Check for end of current dollar-quote tag
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
        continue;
      }
      current += ch;
      continue;
    }

    // Handle normal quotes
    if (!inDoubleQuote && ch === "'" && !dollarTag) {
      // Toggle single quotes, handle escapes ('' inside)
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (!inSingleQuote && ch === '"' && !dollarTag) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    // Statement termination only when not in any quoted/comment block
    if (!inSingleQuote && !inDoubleQuote && !dollarTag && ch === ";") {
      current += ch;
      flush();
      continue;
    }

    current += ch;
  }

  if (current.trim().length > 0) {
    flush();
  }

  return statements;
}