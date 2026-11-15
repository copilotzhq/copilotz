/**
 * Identifiers, as password sign-in reads them: a username, a badge number, a
 * CPF. One is matched without its spaces and without case (` Ana.Lima ` is
 * `ana.lima`), and without the characters the app says to ignore
 * (`passwordSignIn.ignore`: `".-/"` for a CPF typed with its dots), the same
 * wherever it comes from: the sign-in form, `password.set`, an import.
 */
import { failure } from "../../../../runtime/mod.ts";

/** An identifier's input schema. */
export const IDENTIFIER = { type: "string", minLength: 1, maxLength: 200 } as const;

/** The longest identifier kept, once read. */
const LONGEST = 120;

/** An identifier as it's kept; refused when nothing's left of it, or too much. */
export function identifierIn(text: string, ignore = ""): string {
  const dropped = new Set([...ignore]);
  const kept = [...text.normalize("NFC").toLowerCase()]
    .filter((c) => !/[\s\p{Cc}]/u.test(c) && !dropped.has(c)).join("");
  if (!kept || [...kept].length > LONGEST) {
    throw failure("invalid", "Enter your username.", { public: true });
  }
  return kept;
}
