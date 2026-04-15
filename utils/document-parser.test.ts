import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  DOCX_MIME,
  detectOfficeDocumentMime,
  parseDocumentToText,
} from "@/utils/document-parser.ts";
import {
  buildAssetRefForStore,
  createMemoryAssetStore,
  resolveAssetRefsInMessages,
} from "@/runtime/storage/assets.ts";
import type { ChatMessage } from "@/runtime/llm/types.ts";

function writeUInt16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xFF;
  target[offset + 1] = (value >>> 8) & 0xFF;
}

function writeUInt32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xFF;
  target[offset + 1] = (value >>> 8) & 0xFF;
  target[offset + 2] = (value >>> 16) & 0xFF;
  target[offset + 3] = (value >>> 24) & 0xFF;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function createStoredZip(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const localFiles: Uint8Array[] = [];
  const centralEntries: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const dataBytes = encoder.encode(content);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    writeUInt32(localHeader, 0, 0x04034B50);
    writeUInt16(localHeader, 4, 20);
    writeUInt16(localHeader, 6, 0);
    writeUInt16(localHeader, 8, 0);
    writeUInt16(localHeader, 10, 0);
    writeUInt16(localHeader, 12, 0);
    writeUInt32(localHeader, 14, 0);
    writeUInt32(localHeader, 18, dataBytes.length);
    writeUInt32(localHeader, 22, dataBytes.length);
    writeUInt16(localHeader, 26, nameBytes.length);
    writeUInt16(localHeader, 28, 0);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    writeUInt32(centralHeader, 0, 0x02014B50);
    writeUInt16(centralHeader, 4, 20);
    writeUInt16(centralHeader, 6, 20);
    writeUInt16(centralHeader, 8, 0);
    writeUInt16(centralHeader, 10, 0);
    writeUInt16(centralHeader, 12, 0);
    writeUInt16(centralHeader, 14, 0);
    writeUInt32(centralHeader, 16, 0);
    writeUInt32(centralHeader, 20, dataBytes.length);
    writeUInt32(centralHeader, 24, dataBytes.length);
    writeUInt16(centralHeader, 28, nameBytes.length);
    writeUInt16(centralHeader, 30, 0);
    writeUInt16(centralHeader, 32, 0);
    writeUInt16(centralHeader, 34, 0);
    writeUInt16(centralHeader, 36, 0);
    writeUInt32(centralHeader, 38, 0);
    writeUInt32(centralHeader, 42, offset);
    centralHeader.set(nameBytes, 46);

    localFiles.push(localHeader, dataBytes);
    centralEntries.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDirectory = concatBytes(centralEntries);
  const eocd = new Uint8Array(22);
  writeUInt32(eocd, 0, 0x06054B50);
  writeUInt16(eocd, 4, 0);
  writeUInt16(eocd, 6, 0);
  writeUInt16(eocd, 8, Object.keys(entries).length);
  writeUInt16(eocd, 10, Object.keys(entries).length);
  writeUInt32(eocd, 12, centralDirectory.length);
  writeUInt32(eocd, 16, offset);
  writeUInt16(eocd, 20, 0);

  return concatBytes([...localFiles, centralDirectory, eocd]);
}

function createDocxBytes(text: string): Uint8Array {
  return createStoredZip({
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
    "word/document.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
}

Deno.test("detectOfficeDocumentMime identifies DOCX bytes", () => {
  const bytes = createDocxBytes("Hello from DOCX");
  assertEquals(detectOfficeDocumentMime(bytes), DOCX_MIME);
});

Deno.test("parseDocumentToText extracts DOCX text", async () => {
  const bytes = createDocxBytes("Hello from DOCX");
  const parsed = await parseDocumentToText(bytes, DOCX_MIME);

  assert(parsed);
  assertEquals(parsed.kind, "docx");
  assertStringIncludes(parsed.text, "Hello from DOCX");
});

Deno.test("resolveAssetRefsInMessages converts DOCX asset refs into text", async () => {
  const bytes = createDocxBytes("Seat selection instructions");
  const store = createMemoryAssetStore();
  const saved = await store.save(bytes, DOCX_MIME);
  const ref = buildAssetRefForStore(store, saved.assetId);

  const input: ChatMessage[] = [{
    role: "user",
    content: [{
      type: "file",
      file: {
        file_data: ref,
        mime_type: DOCX_MIME,
      },
    }],
  }];

  const resolved = await resolveAssetRefsInMessages(input, store);
  const content = resolved.messages[0].content;

  assert(Array.isArray(content));
  assertEquals(content[0]?.type, "text");
  assertStringIncludes(
    (content[0] as { text: string }).text,
    "Seat selection instructions",
  );
  assertEquals(resolved.referenced.length, 1);
});

Deno.test("resolveAssetRefsInMessages falls back to text notice for invalid DOCX", async () => {
  const store = createMemoryAssetStore();
  const badBytes = new TextEncoder().encode("not-a-real-docx");
  const saved = await store.save(badBytes, DOCX_MIME);
  const ref = buildAssetRefForStore(store, saved.assetId);

  const input: ChatMessage[] = [{
    role: "user",
    content: [{
      type: "file",
      file: {
        file_data: ref,
        mime_type: DOCX_MIME,
      },
    }],
  }];

  const resolved = await resolveAssetRefsInMessages(input, store);
  const content = resolved.messages[0].content;

  assert(Array.isArray(content));
  assertEquals(content[0]?.type, "text");
  assertStringIncludes(
    (content[0] as { text: string }).text,
    "could not be parsed",
  );
});

Deno.test("resolveAssetRefsInMessages passes through unsupported files", async () => {
  const store = createMemoryAssetStore();
  const bytes = new TextEncoder().encode("fake binary");
  const mime = "application/x-custom-binary";
  const saved = await store.save(bytes, mime);
  const ref = buildAssetRefForStore(store, saved.assetId);

  const input: ChatMessage[] = [{
    role: "user",
    content: [{
      type: "file",
      file: {
        file_data: ref,
        mime_type: mime,
      },
    }],
  }];

  const resolved = await resolveAssetRefsInMessages(input, store);
  const content = resolved.messages[0].content;

  assert(Array.isArray(content));
  assertEquals(content[0]?.type, "file");
  assertEquals(
    (content[0] as { file: { mime_type?: string } }).file.mime_type,
    mime,
  );
});
