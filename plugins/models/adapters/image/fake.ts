/**
 * Offline images (`"fake/<anything>"`): a one-pixel PNG for each image
 * asked, and a line saying what it was asked for. For tests and demos.
 */
import type { ImageAdapter } from "../../shared/image.ts";

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const fake: ImageAdapter = {
  generate: ({ prompt, references, count = 1 }) =>
    Promise.resolve({
      images: Array.from({ length: count }, () => ({ type: "image/png", data: PIXEL })),
      text: `(An image of: ${prompt}` +
        (references.length ? `, from ${references.length} reference(s).)` : ".)"),
    }),
};
