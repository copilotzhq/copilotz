/**
 * Environment variables as people type them on the web: a space's names
 * (capitals, digits and `_`, as typed: `api url` becomes `API_URL`), and a
 * job's own, one `NAME=value` a line (as a `.env` file says them).
 */

/** What a space's variable may be named. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** What a job's own may be named (a program's environment takes lower case too). */
const JOB_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name as it's typed: capitals, with spaces, dashes and dots as `_`, and nothing else. */
export const typedName = (typed: string): string =>
  typed.toUpperCase().replace(/[\s.-]/g, "_").replace(/[^A-Z0-9_]/g, "").slice(0, 128);

/** What's wrong with a name, if anything. */
export function nameProblem(name: string): string | undefined {
  if (!name) return "It needs a name.";
  if (/^[0-9]/.test(name)) return "A name can't start with a digit.";
  return ENV_NAME.test(name) ? undefined : "Capital letters, digits and _ only.";
}

/**
 * A job's own environment, one `NAME=value` a line: blank lines and `#`
 * comments skipped, `export ` before a name allowed, a value in matching
 * quotes taken without them. Empty: none.
 */
export function envLines(text: string): { env?: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    const name = (at < 0 ? line : line.slice(0, at)).replace(/^export\s+/, "").trim();
    if (at < 0 || !JOB_NAME.test(name)) {
      return { error: `Line ${i + 1} isn't NAME=value: ${line.slice(0, 40)}` };
    }
    const value = line.slice(at + 1).trim();
    const quoted = value.length > 1 && /^(["']).*\1$/.test(value);
    env[name] = quoted ? value.slice(1, -1) : value;
  }
  return Object.keys(env).length ? { env } : {};
}

/** A value as one line shows it: its first line, and that there's more. */
export const oneLine = (value: string): string => {
  const lines = value.split(/\r?\n/);
  return lines.length > 1 ? `${lines[0]} …` : value;
};
