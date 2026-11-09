/**
 * What boards' Actions refuse with, in words: something asked that can't be
 * (`invalid`), something that isn't there or isn't reached (`not_found`:
 * the rules keep what someone can't read out of sight, so the two are one),
 * and a change the rules turned down (`forbidden`: they may read it there,
 * not change it).
 */

export const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });

export const notFound = (message: string) =>
  Object.assign(new Error(message), { code: "not_found" });

export const forbidden = (message: string) =>
  Object.assign(new Error(message), { code: "forbidden" });

/** A change to a board or its cards that the rules turned down. */
export const READ_ONLY = "You can read this board, but only its space's editors change it.";

/** A change the rules turned down, said in words. */
export const readOnly = (message = READ_ONLY) => forbidden(message);

/** A refusal by the rules, said in words (`message`); anything else, as it was. */
export const said = (message = READ_ONLY) => (error: unknown): never => {
  if ((error as { code?: string }).code === "forbidden") throw forbidden(message);
  throw error;
};
