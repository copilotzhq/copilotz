/** Code 39 symbols in check-character order. Each set bit is a wide element. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
const WIDE = [
  0x034,
  0x121,
  0x061,
  0x160,
  0x031,
  0x130,
  0x070,
  0x025,
  0x124,
  0x064,
  0x109,
  0x049,
  0x148,
  0x019,
  0x118,
  0x058,
  0x00d,
  0x10c,
  0x04c,
  0x01c,
  0x103,
  0x043,
  0x142,
  0x013,
  0x112,
  0x052,
  0x007,
  0x106,
  0x046,
  0x016,
  0x181,
  0x0c1,
  0x1c0,
  0x091,
  0x190,
  0x0d0,
  0x085,
  0x184,
  0x0c4,
  0x0a8,
  0x0a2,
  0x08a,
  0x02a,
];

/** Encodes a Code 39 label as alternating bar and space widths, with an optional Mod 43 check character. */
export function code39(value: string, { check = false }: { check?: boolean } = {}): number[] {
  const digits = [...value].map((c) => ALPHABET.indexOf(c));
  if (digits.includes(-1)) throw new RangeError("Unsupported character in Code 39.");
  if (check) digits.push(digits.reduce((sum, d) => sum + d, 0) % 43);
  const patterns = [0x094, ...digits.map((d) => WIDE[d]), 0x094];
  const widths: number[] = [];
  for (const pattern of patterns) {
    if (widths.length) widths.push(1);
    for (let bit = 8; bit >= 0; bit--) widths.push(pattern & (1 << bit) ? 2 : 1);
  }
  return widths;
}

const DIGITS = ["3211", "2221", "2122", "1411", "1132", "1231", "1114", "1312", "1213", "3112"];
const PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
];

/** Completes an EAN from its body or validates all its digits, keeping leading zeros. */
export function eanDigits(value: string, length: 8 | 13): string {
  if (!/^\d+$/.test(value) || (value.length !== length && value.length !== length - 1)) {
    throw new RangeError(`EAN-${length} needs ${length - 1} or ${length} digits.`);
  }
  const body = value.slice(0, length - 1);
  const sum = [...body].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 ? 1 : 3), 0);
  const full = body + (10 - sum % 10) % 10;
  if (value.length === length && value !== full) throw new RangeError("Invalid EAN check digit.");
  return full;
}

function ean(value: string, length: 8 | 13): number[] {
  const full = eanDigits(value, length);
  const parity = length === 13 ? PARITY[Number(full[0])] : "LLLL";
  const digits = full.slice(-2 * parity.length);
  const widths = [1, 1, 1];
  [...digits].forEach((d, i) => {
    if (i === parity.length) widths.push(1, 1, 1, 1, 1);
    const pattern = [...DIGITS[Number(d)]].map(Number);
    widths.push(...(parity[i] === "G" ? pattern.reverse() : pattern));
  });
  return [...widths, 1, 1, 1];
}

/** EAN-8 module widths for seven product digits, or eight with a valid check digit. */
export const ean8 = (value: string): number[] => ean(value, 8);
/** EAN-13 module widths for twelve product digits, or thirteen with a valid check digit. */
export const ean13 = (value: string): number[] => ean(value, 13);
