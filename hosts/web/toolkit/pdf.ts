/**
 * PDFs with no library, on a server as in a browser: Helvetica (the font
 * every PDF reader has, regular, bold, oblique and both), text in WinAnsi
 * (Latin, with €, “ ”, – and …; a character outside it prints as "?").
 *
 * - **`tablePdf`**: a table, a header row on a coloured band and striped
 *   rows, as many pages as it takes, the header again on each. Columns share
 *   the width by how much they hold, and a cell too long for its column ends
 *   in "…".
 * - **`documentPdf`**: a document drawn at places, page by page: text (left,
 *   centred or right in a width, wrapped to it), lines, rectangles, images
 *   and vector barcodes. Places are points (1/72 in) from the page's top left. A
 *   page is A4, letter, or a receipt's 80 mm roll, as long as what's on it
 *   (`height: "fit"`). `textWidth` and `wrapText` measure with Helvetica's
 *   own widths, for laying a document out (a receipt's lines, one under
 *   another).
 *
 * ```ts
 * const bytes = tablePdf({ headers: ["Name", "Total"], rows: [["Ann", "12.50"]] }, { title: "Sales" });
 * const receipt = documentPdf([[
 *   { text: "Acme Stores", x: 12, y: 12, width: 203, align: "center", size: 12, font: "bold" },
 *   { line: [12, 34, 215, 34] },
 *   { text: "Total", x: 12, y: 40 }, { text: "R$ 12,50", x: 12, y: 40, width: 203, align: "right" },
 *   { barcode: "POS 12", x: 38, y: 60, width: 150, height: 40 },
 * ]], { size: "receipt" });
 * ```
 */
import type { ExportCell, Sheet } from "./export.ts";
import type { PdfImage } from "./pdf-image.ts";
import { type BarcodeOptions, bars } from "./code128.ts";

/** How the PDF looks: its page, its title, and its colours (`#rrggbb`). */
export type PdfOptions = {
  /** Title lines over the table, on the first page. */
  title?: string | string[];
  /** Smaller lines under the title, on the first page. */
  subtitle?: string | string[];
  /** Paper in points. Named paper defaults to landscape, a pair keeps its given orientation. */
  size?: "a4" | "letter" | [number, number];
  /** Columns in visible order. Widths are points. Unspecified columns share what remains. */
  columns?: { width?: number; align?: "left" | "center" | "right" }[];
  /** A prepared logo beside the first page's title. Width and height are in points. */
  headerImage?: { image: PdfImage; width: number; height: number };
  /** Rotates the paper to landscape or portrait. Named paper defaults to landscape. */
  orientation?: "landscape" | "portrait";
  /** The header band's colour, and its text's. */
  headerColor?: string;
  headerText?: string;
  /** Every other row's colour (`null`: none). */
  stripeColor?: string | null;
  /** Points, 9 by default. */
  fontSize?: number;
};

/** Unicode's characters WinAnsi has between 0x80 and 0x9f. */
const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Text as WinAnsi bytes, one character each (a string of char codes 0–255). */
export function winAnsi(text: string): string {
  return [...text.normalize("NFC")].map((char) => {
    const code = char.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return char;
    if (code === 0x09 || code === 0x0a || code === 0x0d) return " ";
    return String.fromCharCode(WIN_ANSI[code] ?? 0x3f);
  }).join("");
}

/** A WinAnsi string as a PDF literal's inside. */
const literal = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

/** A colour as PDF's fill operands, from `#rgb` or `#rrggbb` (black otherwise). */
function rgb(colour: string): string {
  let hex = colour.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join("");
  if (!/^[\da-f]{6}$/i.test(hex)) return "0 0 0";
  return [0, 2, 4].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
}

/** A printable table, with repeated column headings and totals after its final row. */
export function tablePdf(
  { headers, rows, footerRows = [] }: Sheet<ExportCell>,
  options: PdfOptions = {},
): Uint8Array {
  const paper = options.size ?? "a4";
  const [a, b] = Array.isArray(paper) ? paper : [SIZES[paper].width, Number(SIZES[paper].height)];
  const orientation = options.orientation ?? (Array.isArray(paper) ? undefined : "landscape");
  const W = orientation === "portrait"
    ? Math.min(a, b)
    : orientation === "landscape"
    ? Math.max(a, b)
    : a;
  const H = a + b - W;
  const M = 36, SIZE = options.fontSize ?? 9, LINE = Math.max(1, Math.round(SIZE * 2));
  const available = W - 2 * M;
  if (![W, H, SIZE].every(Number.isFinite) || SIZE <= 0 || available <= 0 || H < 2 * M + 2 * LINE) {
    throw new RangeError("The page must have room for a table heading and a row.");
  }
  const cells = [...rows, ...footerRows].map((row) =>
    headers.map((_, i) => winAnsi(String(row[i] ?? "")))
  );
  const heads = headers.map(winAnsi);
  const columns = options.columns ?? [];
  const weights = heads.map((h, i) =>
    columns[i]?.width === undefined ? Math.max(3, Math.min(40, h.length)) : 0
  );
  for (const row of cells) {
    row.forEach((v, i) => {
      if (weights[i]) weights[i] = Math.max(weights[i], Math.min(40, v.length));
    });
  }
  const fixed = heads.reduce((sum, _, i) => {
    const width = columns[i]?.width;
    if (width !== undefined && (!Number.isFinite(width) || width <= 0)) {
      throw new RangeError("Invalid PDF column width.");
    }
    return sum + (width ?? 0);
  }, 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (fixed > available || (sum && fixed >= available)) {
    throw new RangeError("Columns exceed the page width.");
  }
  const widths = weights.map((w, i) => columns[i]?.width ?? (available - fixed) * w / sum);
  const tableWidth = widths.reduce((a, b) => a + b, 0);
  const lines = (s?: string | string[]) =>
    (Array.isArray(s) ? s : s ? [s] : []).flatMap((v) => v.split(/\r?\n/));
  const titles = lines(options.title), subtitles = lines(options.subtitle);
  const logo = options.headerImage;
  if (
    logo &&
    (![logo.width, logo.height].every((n) => Number.isFinite(n) && n > 0) || logo.width > available)
  ) {
    throw new RangeError("Invalid PDF header image size.");
  }
  const captionX = M + (logo && (titles.length || subtitles.length) ? logo.width + 8 : 0);
  const headingHeight = Math.max(
    titles.length * (SIZE + 8) + subtitles.length * (SIZE + 4),
    logo?.height ?? 0,
  );
  const firstTop = H - M - headingHeight - (headingHeight ? 8 : 0);
  if (firstTop - M < LINE * (cells.length ? 2 : 1)) {
    throw new RangeError("The table heading is too tall for this page.");
  }
  const head = rgb(options.headerColor ?? "#334058"),
    headText = rgb(options.headerText ?? "#ffffff");
  const stripe = options.stripeColor === null ? null : rgb(options.stripeColor ?? "#f1f4f9");
  const pages: { width: number; height: number; stream: string }[] = [];
  let start = 0;
  do {
    const ops: string[] = [];
    let top = H - M;
    if (!pages.length) {
      if (logo) {
        ops.push(
          `q ${n(logo.width)} 0 0 ${n(logo.height)} ${M} ${n(top - logo.height)} cm /Im1 Do Q`,
        );
      }
      const caption = (line: string, size: number, font: string) => {
        const { shown } = fitCell(winAnsi(line), W - M - captionX, size, font === "F2");
        ops.push(
          `0 0 0 rg BT /${font} ${n(size)} Tf ${n(captionX)} ${n(top - size)} Td (${
            literal(shown)
          }) Tj ET`,
        );
        top -= size + 4;
      };
      titles.forEach((line) => caption(line, SIZE + 4, "F2"));
      subtitles.forEach((line) => caption(line, SIZE, "F1"));
      top = firstTop;
    }
    const line = (texts: string[], bold: boolean, ink: string, fill?: string | null) => {
      if (fill) ops.push(`${fill} rg ${M} ${n(top - LINE)} ${n(tableWidth)} ${LINE} re f`);
      let x = M;
      texts.forEach((value, i) => {
        const room = Math.max(0, widths[i] - 6);
        const { shown, width } = fitCell(value, room, SIZE, bold);
        const align = columns[i]?.align;
        const offset = align === "right"
          ? room - width
          : align === "center"
          ? (room - width) / 2
          : 0;
        ops.push(
          `${ink} rg BT /${bold ? "F2" : "F1"} ${SIZE} Tf ${n(x + 3 + offset)} ${
            n(top - LINE / 2 - SIZE / 3)
          } Td (${literal(shown)}) Tj ET`,
        );
        x += widths[i];
      });
      top -= LINE;
    };
    line(heads, true, headText, head);
    const end = Math.min(cells.length, start + Math.floor((top - M) / LINE));
    for (let i = start; i < end; i++) {
      line(cells[i], i >= rows.length, "0 0 0", (i - start) % 2 ? stripe : null);
    }
    start = end;
    pages.push({ width: W, height: H, stream: ops.join("\n") });
  } while (start < cells.length);
  return assemble(pages, ["regular", "bold"], logo ? new Map([[logo.image, "Im1"]]) : undefined);
}

/** Fits WinAnsi text to the available points, including the ellipsis and the chosen face. */
function fitCell(value: string, room: number, size: number, bold: boolean) {
  let width = 0;
  const ellipsis = size; // Helvetica's ellipsis is one em.
  let cut = 0, truncatedWidth = 0;
  for (let i = 0; i < value.length; i++) {
    width += charWidth(value[i], bold) * size / 1000;
    if (width <= room - ellipsis) {
      cut = i + 1;
      truncatedWidth = width;
    }
    if (width > room) {
      return room >= ellipsis
        ? { shown: value.slice(0, cut) + "\x85", width: truncatedWidth + ellipsis }
        : { shown: "", width: 0 };
    }
  }
  return { shown: value, width };
}

/** Helvetica's four faces, and their names in a page's resources. */
export type PdfFont = "regular" | "bold" | "italic" | "bold-italic";
const FACES: Record<PdfFont, [name: string, base: string]> = {
  regular: ["F1", "Helvetica"],
  bold: ["F2", "Helvetica-Bold"],
  italic: ["F3", "Helvetica-Oblique"],
  "bold-italic": ["F4", "Helvetica-BoldOblique"],
};

/**
 * The file around pages' drawing: the catalog, the faces used, each page
 * (its size and its content stream, WinAnsi text as one char per byte), and
 * the cross-reference table that says where each object starts.
 */
function assemble(
  pages: { width: number; height: number; stream: string }[],
  fonts: PdfFont[],
  images: Map<PdfImage, string> = new Map(),
): Uint8Array {
  const used = (Object.keys(FACES) as PdfFont[]).filter((font) => fonts.includes(font));
  const objects: (string | (string | Uint8Array)[])[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "", // the pages, once their numbers are known
    ...used.map((font) =>
      `<< /Type /Font /Subtype /Type1 /BaseFont /${FACES[font][1]} /Encoding /WinAnsiEncoding >>`
    ),
  ];
  const resources = used.map((font, i) => `/${FACES[font][0]} ${i + 3} 0 R`).join(" ");
  const xobjects: string[] = [];
  for (const [image, name] of images) {
    const base = `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height}`;
    const stream = (dict: string, data: Uint8Array) =>
      objects.push([
        `<< ${base} ${dict} /Length ${data.length} >>\nstream\n`,
        data,
        "\nendstream",
      ]);
    const mask = image.alpha &&
      stream("/BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode", image.alpha);
    const space = image.palette
      ? `[/Indexed /DeviceRGB ${image.palette.length / 3 - 1} <${
        Array.from(image.palette, (b) => b.toString(16).padStart(2, "0")).join("")
      }>]`
      : image.colors === 1
      ? "/DeviceGray"
      : image.colors === 3
      ? "/DeviceRGB"
      : "/DeviceCMYK";
    const params = image.predictor
      ? ` /DecodeParms << /Predictor 15 /Colors ${image.colors} /BitsPerComponent ${image.bits} /Columns ${image.width} >>`
      : "";
    const id = stream(
      `/BitsPerComponent ${image.bits} /ColorSpace ${space} /Filter /${image.filter}${params}` +
        (image.inverted ? " /Decode [1 0 1 0 1 0 1 0]" : "") + (mask ? ` /SMask ${mask} 0 R` : ""),
      image.data,
    );
    xobjects.push(`/${name} ${id} 0 R`);
  }
  const imageResources = xobjects.length ? ` /XObject << ${xobjects.join(" ")} >>` : "";
  const kids: number[] = [];
  for (const { width, height, stream } of pages) {
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contents = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << ${resources} >>${imageResources} >> /Contents ${contents} 0 R >>`,
    );
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${
    kids.map((k) => `${k} 0 R`).join(" ")
  }] /Count ${kids.length} >>`;
  const parts: (string | Uint8Array)[] = [];
  let length = 0;
  const write = (part: string | Uint8Array) => {
    parts.push(part);
    length += part.length;
  };
  write("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    write(`${i + 1} 0 obj\n`);
    if (Array.isArray(body)) body.forEach(write);
    else write(body);
    write("\nendobj\n");
  });
  const xref = length;
  write(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    if (typeof part === "string") {
      for (let i = 0; i < part.length; i++) out[at++] = part.charCodeAt(i);
    } else {
      out.set(part, at);
      at += part.length;
    }
  }
  return out;
}

/** Helvetica's widths (thousandths of its size), for its characters 32 to 126. */
const WIDTHS = {
  regular:
    "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 " +
    "556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 " +
    "778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 " +
    "278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 " +
    "334 584",
  bold:
    "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 " +
    "556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 " +
    "778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 " +
    "333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 " +
    "389 584",
};
const ASCII = {
  regular: WIDTHS.regular.split(" ").map(Number),
  bold: WIDTHS.bold.split(" ").map(Number),
};
/** The rest of WinAnsi that isn't a Latin letter with a mark (those are their letter's width). */
const OTHERS: Record<string, number> = {
  "\x80": 556,
  "\x82": 222,
  "\x83": 556,
  "\x84": 333,
  "\x85": 1000,
  "\x86": 556,
  "\x87": 556,
  "\x88": 333,
  "\x89": 1000,
  "\x8b": 333,
  "\x8c": 1000,
  "\x91": 222,
  "\x92": 222,
  "\x93": 333,
  "\x94": 333,
  "\x95": 350,
  "\x96": 556,
  "\x97": 1000,
  "\x98": 333,
  "\x99": 1000,
  "\x9b": 333,
  "\x9c": 944,
  "\xa0": 278,
  "\xa1": 333,
  "\xa6": 260,
  "\xa9": 737,
  "\xaa": 370,
  "\xab": 556,
  "\xac": 584,
  "\xad": 333,
  "\xae": 737,
  "\xb0": 400,
  "\xb1": 584,
  "\xb2": 333,
  "\xb3": 333,
  "\xb6": 537,
  "\xb7": 278,
  "\xb9": 333,
  "\xba": 365,
  "\xbb": 556,
  "\xbc": 834,
  "\xbd": 834,
  "\xbe": 834,
  "\xbf": 611,
  "\xc6": 1000,
  "\xd7": 584,
  "\xd8": 778,
  "\xdf": 611,
  "\xe6": 889,
  "\xf7": 584,
  "\xf8": 611,
};

/** One WinAnsi character's width, in thousandths of the size. */
function charWidth(char: string, bold: boolean): number {
  const table = bold ? ASCII.bold : ASCII.regular;
  const code = char.charCodeAt(0);
  if (code >= 32 && code <= 126) return table[code - 32];
  if (char in OTHERS) return OTHERS[char];
  // A letter with a mark is as wide as the letter (á as a, Ç as C); Š, Ž, Ÿ from WinAnsi's own.
  const named: Record<string, string> = {
    "\x8a": "S",
    "\x8e": "Z",
    "\x9a": "s",
    "\x9e": "z",
    "\x9f": "Y",
  };
  const base = (named[char] ?? char).normalize("NFD")[0];
  const at = base.charCodeAt(0);
  return at >= 32 && at <= 126 ? table[at - 32] : 556;
}

/** How wide a text is in Helvetica, in points, at a size (10 by default). */
export function textWidth(text: string, size = 10, font: PdfFont = "regular"): number {
  const bold = font === "bold" || font === "bold-italic";
  return [...winAnsi(text)].reduce((sum, char) => sum + charWidth(char, bold), 0) * size / 1000;
}

/**
 * A text in lines that fit a width, as Helvetica sets them: broken between
 * words, a word longer than the width broken where it must; its own line
 * breaks kept.
 */
export function wrapText(
  text: string,
  width: number,
  size = 10,
  font: PdfFont = "regular",
): string[] {
  const fits = (line: string) => textWidth(line, size, font) <= width;
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      const tried = line ? `${line} ${word}` : word;
      if (fits(tried)) {
        line = tried;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      // A word too long for a line on its own: as much of it as fits, then the rest.
      let rest = word;
      while (rest && !fits(rest)) {
        let cut = rest.length - 1;
        while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** What a document's page holds, each at a place from the page's top left, in points. */
export type Drawn =
  | {
    text: string;
    x: number;
    /** The top of its first line. */
    y: number;
    /** Points, 10 by default. */
    size?: number;
    font?: PdfFont;
    /** `#rrggbb`, black by default. */
    color?: string;
    /** Within `width`: wrapped to it, and set left, centred or right. Without one, one line from `x`. */
    width?: number;
    align?: "left" | "center" | "right";
    /** From one line's top to the next's, 1.25 times the size by default. */
    lineHeight?: number;
  }
  | {
    /** From `[x1, y1]` to `[x2, y2]`. */
    line: [number, number, number, number];
    color?: string;
    /** Points, 0.75 by default. */
    thickness?: number;
  }
  | {
    /** `[x, y, width, height]`, filled (`fill`), outlined (`stroke`), or both; filled black when neither. */
    rect: [number, number, number, number];
    fill?: string;
    stroke?: string;
    thickness?: number;
  }
  | {
    /** A barcode of this text, as `Barcode` draws it, with preferred `width`. */
    barcode: string;
    x: number;
    y: number;
    width: number;
    height: number;
    set?: "auto" | "B";
    quiet?: boolean;
    color?: string;
  };

/** documentPdf can size a barcode from its position and the page's width. */
type BarcodeInput = Omit<Extract<Drawn, { barcode: string }>, "width"> & BarcodeOptions & {
  width?: number;
};
type DocumentItem =
  | Drawn
  | BarcodeInput
  | { image: PdfImage; x: number; y: number; width: number; height: number };

/** A page's size in points: a name, `[width, height]`, or a width and `"fit"` (as tall as what's on it). */
export type PageSize =
  | "a4"
  | "a4-landscape"
  | "letter"
  | "receipt"
  | [number, number]
  | { width: number; height: number | "fit" };

const SIZES: Record<string, { width: number; height: number | "fit" }> = {
  a4: { width: 595, height: 842 },
  "a4-landscape": { width: 842, height: 595 },
  letter: { width: 612, height: 792 },
  // An 80 mm roll, as long as the receipt.
  receipt: { width: 227, height: "fit" },
};

/** A number as a content stream writes it: two decimals at most. */
const n = (value: number) => String(Math.round(value * 100) / 100);

/** How far down a drawn thing reaches, from the page's top. */
function bottomOf(drawn: DocumentItem): number {
  if ("text" in drawn) {
    const size = drawn.size ?? 10;
    const lines = drawn.width === undefined
      ? 1
      : wrapText(drawn.text, drawn.width, size, drawn.font).length;
    return drawn.y + lines * (drawn.lineHeight ?? size * 1.25);
  }
  if ("line" in drawn) return Math.max(drawn.line[1], drawn.line[3]);
  if ("rect" in drawn) return drawn.rect[1] + drawn.rect[3];
  return drawn.y + drawn.height;
}

/** One page's drawing, as a content stream, its places turned to PDF's (from the bottom left). */
function draw(
  items: DocumentItem[],
  width: number,
  height: number,
  fonts: Set<PdfFont>,
  images: Map<PdfImage, string>,
): string {
  const ops: string[] = [];
  const up = (y: number) => n(height - y);
  for (const item of items) {
    if ("text" in item) {
      const size = item.size ?? 10;
      const font = item.font ?? "regular";
      fonts.add(font);
      const lead = item.lineHeight ?? size * 1.25;
      const lines = item.width === undefined
        ? [item.text]
        : wrapText(item.text, item.width, size, font);
      lines.forEach((line, i) => {
        const room = item.width ?? 0;
        const wide = textWidth(line, size, font);
        const align = item.align ?? "left";
        const x = align === "left"
          ? item.x
          : align === "center"
          ? item.x + (room - wide) / 2
          : item.x + room - wide;
        // The baseline: the line's middle, lowered by half of Helvetica's capital height.
        const baseline = item.y + i * lead + lead / 2 + size * 0.36;
        ops.push(
          `${rgb(item.color ?? "#000")} rg BT /${FACES[font][0]} ${n(size)} Tf ${n(x)} ${
            up(baseline)
          } Td (${literal(winAnsi(line))}) Tj ET`,
        );
      });
    } else if ("line" in item) {
      const [x1, y1, x2, y2] = item.line;
      ops.push(
        `${rgb(item.color ?? "#000")} RG ${n(item.thickness ?? 0.75)} w ${n(x1)} ${up(y1)} m ${
          n(x2)
        } ${up(y2)} l S`,
      );
    } else if ("rect" in item) {
      const [x, y, w, h] = item.rect;
      const box = `${n(x)} ${up(y + h)} ${n(w)} ${n(h)} re`;
      const fill = item.fill ?? (item.stroke ? undefined : "#000");
      const paint = fill && item.stroke ? "B" : fill ? "f" : "S";
      ops.push(
        [
          fill ? `${rgb(fill)} rg` : "",
          item.stroke ? `${rgb(item.stroke)} RG ${n(item.thickness ?? 0.75)} w` : "",
          `${box} ${paint}`,
        ].filter(Boolean).join(" "),
      );
    } else if ("image" in item) {
      const name = images.get(item.image) ?? `Im${images.size + 1}`;
      images.set(item.image, name);
      ops.push(
        `q ${n(item.width)} 0 0 ${n(item.height)} ${n(item.x)} ${
          up(item.y + item.height)
        } cm /${name} Do Q`,
      );
    } else {
      const drawn = bars(item.barcode, item.width ?? width - item.x, item);
      const first = drawn.bars[0];
      const last = drawn.bars[drawn.bars.length - 1];
      if (
        !(item.x + first.x >= 0 && item.x + last.x + last.w <= width &&
          item.y >= 0 && item.height >= 0 && item.y + item.height <= height)
      ) {
        throw new RangeError("Barcode bars must fit on the page.");
      }
      // Whole modules, as the screen's: a module is the most whole points that fit.
      ops.push(`${rgb(item.color ?? "#000")} rg`);
      for (const bar of drawn.bars) {
        ops.push(
          `${n(item.x + bar.x)} ${up(item.y + item.height)} ${n(bar.w)} ${n(item.height)} re f`,
        );
      }
    }
  }
  return ops.join("\n");
}

/** A document as PDF bytes: each page's drawing, on pages of one `size` (A4 by default). */
export function documentPdf(
  pages: DocumentItem[][],
  { size = "a4", margin = 12 }: {
    size?: PageSize;
    /** Under what's drawn, on a page whose height fits it. */
    margin?: number;
  } = {},
): Uint8Array {
  const page = Array.isArray(size)
    ? { width: size[0], height: size[1] }
    : typeof size === "string"
    ? SIZES[size]
    : size;
  const fonts = new Set<PdfFont>();
  const images = new Map<PdfImage, string>();
  const drawn = (pages.length ? pages : [[]]).map((items) => {
    const height = page.height === "fit"
      ? Math.ceil(Math.max(0, ...items.map(bottomOf)) + margin)
      : page.height;
    return { width: page.width, height, stream: draw(items, page.width, height, fonts, images) };
  });
  return assemble(drawn, [...fonts], images);
}
