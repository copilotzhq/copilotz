/**
 * Maintenance statements at once: each holds a connection of its own (a
 * PostgreSQL session, a SQLite process), so a store runs at most so many,
 * and refuses another past that (`busy`) rather than queue it.
 */
import { failure } from "../../../runtime/errors.ts";

/** Runs work within `max` at once; `busy` past that. */
export function connections(max = 2) {
  let open = 0;
  return async <R>(work: () => Promise<R>): Promise<R> => {
    if (open >= max) {
      throw failure(
        "busy",
        `Maintenance is running ${open} statement${open === 1 ? "" : "s"} already: try again.`,
      );
    }
    open++;
    try {
      return await work();
    } finally {
      open--;
    }
  };
}
