const REPLACEMENT_CHARACTER = "\uFFFD";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}

/**
 * Replaces unpaired UTF-16 surrogate code units while preserving valid pairs.
 *
 * JavaScript strings may contain lone surrogates, but PostgreSQL JSON/JSONB
 * rejects them. External tools and code-unit-based truncation can both produce
 * these malformed strings.
 */
export function toWellFormedUnicode(value: string): string {
  let repaired: string | undefined;
  let copyStart = 0;

  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);

    if (isHighSurrogate(codeUnit)) {
      if (isLowSurrogate(value.charCodeAt(index + 1))) {
        index++;
        continue;
      }
    } else if (!isLowSurrogate(codeUnit)) {
      continue;
    }

    repaired ??= "";
    repaired += value.slice(copyStart, index) + REPLACEMENT_CHARACTER;
    copyStart = index + 1;
  }

  return repaired === undefined ? value : repaired + value.slice(copyStart);
}

/**
 * Returns a UTF-16-length-bounded prefix without splitting a valid surrogate
 * pair, and repairs any malformed surrogate already present in the source.
 */
export function wellFormedUnicodePrefix(
  value: string,
  maxCodeUnits: number,
): string {
  let end = Math.max(0, Math.min(value.length, Math.floor(maxCodeUnits)));

  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end--;
  }

  return toWellFormedUnicode(value.slice(0, end));
}
