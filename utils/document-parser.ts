export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const DEFAULT_DOCUMENT_TEXT_LIMIT = 20_000;

export type SupportedDocumentKind = "docx";

export interface ParsedDocument {
  kind: SupportedDocumentKind;
  mime: string;
  text: string;
  truncated: boolean;
}

type ZipEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

const OOXML_SIGNATURES = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
} as const;

function readUInt16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]) |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24);
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  if (needle.length === 0 || needle.length > bytes.length) return false;

  outer:
  for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }

  return false;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  // 64KB is the ZIP comment limit; scan backward for EOCD.
  const minOffset = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (readUInt32(bytes, i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  return -1;
}

function parseZipEntries(bytes: Uint8Array): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new Error("ZIP end-of-central-directory record not found");
  }

  const centralDirectorySize = readUInt32(bytes, eocdOffset + 12);
  const centralDirectoryOffset = readUInt32(bytes, eocdOffset + 16);
  const endOffset = centralDirectoryOffset + centralDirectorySize;
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  let offset = centralDirectoryOffset;
  while (offset < endOffset) {
    if (readUInt32(bytes, offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const compressionMethod = readUInt16(bytes, offset + 10);
    const compressedSize = readUInt32(bytes, offset + 20);
    const uncompressedSize = readUInt32(bytes, offset + 24);
    const fileNameLength = readUInt16(bytes, offset + 28);
    const extraLength = readUInt16(bytes, offset + 30);
    const commentLength = readUInt16(bytes, offset + 32);
    const localHeaderOffset = readUInt32(bytes, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd));

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const blobData = new Uint8Array(data).buffer;
  const stream = new Blob([blobData]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const localOffset = entry.localHeaderOffset;
  if (readUInt32(bytes, localOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid ZIP local file header for ${entry.name}`);
  }

  const fileNameLength = readUInt16(bytes, localOffset + 26);
  const extraLength = readUInt16(bytes, localOffset + 28);
  const dataStart = localOffset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  const compressed = bytes.subarray(dataStart, dataEnd);

  switch (entry.compressionMethod) {
    case 0:
      return compressed;
    case 8:
      return await inflateRaw(compressed);
    default:
      throw new Error(
        `Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}`,
      );
  }
}

export function detectOfficeDocumentMime(bytes: Uint8Array): string | null {
  const isZip = bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4B &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
  if (!isZip) return null;

  if (containsAscii(bytes, OOXML_SIGNATURES.docx)) return DOCX_MIME;
  if (containsAscii(bytes, OOXML_SIGNATURES.xlsx)) return XLSX_MIME;
  if (containsAscii(bytes, OOXML_SIGNATURES.pptx)) return PPTX_MIME;
  return null;
}

function detectSupportedDocumentKind(
  bytes: Uint8Array,
  mime?: string,
): SupportedDocumentKind | null {
  const normalizedMime = typeof mime === "string" ? mime.trim().toLowerCase() : "";
  if (normalizedMime === DOCX_MIME) return "docx";

  const detected = detectOfficeDocumentMime(bytes);
  if (detected === DOCX_MIME) return "docx";
  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripWordXml(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^/]*\/>/g, "\t")
      .replace(/<w:(?:br|cr)\b[^/]*\/>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:p>/g, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function parseDocx(bytes: Uint8Array): Promise<string> {
  const decoder = new TextDecoder();
  const entries = parseZipEntries(bytes);
  const candidateNames = [
    "word/document.xml",
    ...entries
      .map((entry) => entry.name)
      .filter((name) => /^word\/header\d+\.xml$/.test(name)),
    ...entries
      .map((entry) => entry.name)
      .filter((name) => /^word\/footer\d+\.xml$/.test(name)),
    "word/footnotes.xml",
    "word/endnotes.xml",
  ];

  const sections: string[] = [];
  for (const name of candidateNames) {
    const entry = entries.find((item) => item.name === name);
    if (!entry) continue;
    const fileBytes = await readZipEntry(bytes, entry);
    const text = stripWordXml(decoder.decode(fileBytes));
    if (text) sections.push(text);
  }

  return sections.join("\n\n").trim();
}

function truncateDocumentText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  const clipped = value.slice(0, Math.max(0, maxChars)).trimEnd();
  return {
    text: `${clipped}\n\n[Document truncated to ${maxChars} characters]`,
    truncated: true,
  };
}

export async function parseDocumentToText(
  bytes: Uint8Array,
  mime?: string,
  options: { maxChars?: number } = {},
): Promise<ParsedDocument | null> {
  const kind = detectSupportedDocumentKind(bytes, mime);
  if (!kind) return null;

  let text = "";
  switch (kind) {
    case "docx":
      text = await parseDocx(bytes);
      break;
  }

  if (!text.trim()) {
    throw new Error("Parsed document did not contain any readable text");
  }

  const { text: truncatedText, truncated } = truncateDocumentText(
    text,
    Math.max(1_000, options.maxChars ?? DEFAULT_DOCUMENT_TEXT_LIMIT),
  );

  return {
    kind,
    mime: DOCX_MIME,
    text: truncatedText,
    truncated,
  };
}
