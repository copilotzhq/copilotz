/** Class names, those given: `cx("copilotz-chip", soft && "copilotz-chip-soft", className)`. */
export const cx = (...names: (string | false | null | undefined)[]): string =>
  names.filter(Boolean).join(" ");
