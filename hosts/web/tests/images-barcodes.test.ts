import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import {
  barcodePng,
  bars,
  code39,
  documentPdf,
  ean13,
  ean8,
  eanDigits,
  pdfImage,
} from "../export.ts";
import { pngPixels, readPng } from "../toolkit/png.ts";

// Two pixels in independently encoded images, including a sub-byte indexed palette.
const images = {
  gray:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAAAAADRSSBWAAAAC0lEQVR4nGOQ0AIAAF0AQ9SL44QAAAAASUVORK5CYII=",
  rgb:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGM0snH7/e8vAAloA6w+K6f8AAAAAElFTkSuQmCC",
  rgba:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGM0snH7//vf30YAE0YFLArUDvIAAAAASUVORK5CYII=",
  grayAlpha:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR4nGNgcPjfAAADQwHAsLQKxwAAAABJRU5ErkJggg==",
  palette:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAMAAADD/I+4AAAABlBMVEUAAAAA/wA2Q0S9AAAAAnRSTlMP5rhilroAAAALSURBVHicY2BgBAAABAACv3o/SgAAAABJRU5ErkJggg==",
  packed:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAABlBMVEUAAAAA/wA2Q0S9AAAAAXRSTlMAQObYZgAAAApJREFUeJxjcAAAAEIAQSk39O8AAAAASUVORK5CYII=",
  filters:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAFCAAAAABK2GJAAAAAF0lEQVR4nGNgZmdkYWNi4WJm42VhYgUAAfkAR8CylxMAAAAASUVORK5CYII=",
  jpeg:
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/N1vvH602nN94/Wm17h45//Z",
};
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bits = (widths: number[]) => widths.map((w, i) => (i % 2 ? "0" : "1").repeat(w)).join("");

test("EAN-13 matches the published symbol, with and without its check digit", () => {
  // ZXing EAN13WriterTestCase.testEncode, without its quiet margins.
  const expected =
    "10100010110100111011001100100110111101001110101010110011011011001000010101110010011101000100101";
  assertEquals(bits(ean13("590123412345")), expected);
  assertEquals(bits(ean13("5901234123457")), expected);
  assertThrows(() => ean13("5901234123458"), RangeError);
  assertThrows(() => ean13("59012"), RangeError);
  assertThrows(() => ean8("abcdefgh"), RangeError);
  assertEquals(eanDigits("0123456", 8), "01234565");
  assertEquals(
    bits(ean8("01234565")),
    "1010001101001100100100110111101010101011100100111010100001001110101",
  );
  assertThrows(() => ean8("01234560"), RangeError);
});

test("Code 39 has its framing symbols, inter-character spaces and optional Mod 43", () => {
  // IDAutomation's Code 39 tutorial: CODE39 sums to 75, its check character is W.
  assertEquals(code39("CODE39", { check: true }), code39("CODE39W"));
  assertEquals(bits(code39("A")), "1001011011010" + "1101010010110" + "100101101101");
  assertThrows(() => code39("lowercase"), RangeError);
  assertThrows(() => code39("*"), RangeError);
});

test("barcode PNG round-trips as the same whole pixels as its bars, on every row", async () => {
  for (const format of ["code128", "code39", "ean8", "ean13"] as const) {
    const value = format === "ean8" ? "0123456" : "590123412345";
    const drawn = bars(value, 350, { format, quiet: true });
    const row = new Uint8Array(drawn.width).fill(255);
    for (const { x, w } of drawn.bars) row.fill(0, x, x + w);
    const png = readPng(await barcodePng(value, { format, width: 350, height: 2 }));
    assertEquals([png.width, png.height], [drawn.width, 2]);
    assertEquals(await pngPixels(png), Uint8Array.from([...row, ...row]));
    const vector = String.fromCharCode(
      ...documentPdf([[{
        barcode: value,
        format,
        x: 0,
        y: 0,
        width: 350,
        height: 20,
        quiet: true,
      }]]),
    );
    assertEquals((vector.match(/ re f/g) ?? []).length, drawn.bars.length);
  }
});

const inflate = async (data: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );

test("pdfImage rejects a JPEG ending after its frame or with an empty scan", async () => {
  const jpeg = bytes(images.jpeg);
  const endOfHeader = (marker: number) => {
    const at = jpeg.findIndex((b, i) => b === 0xff && jpeg[i + 1] === marker) + 2;
    return at + new DataView(jpeg.buffer).getUint16(at);
  };
  const frame = jpeg.slice(0, endOfHeader(0xc0));
  const scan = jpeg.slice(0, endOfHeader(0xda));
  for (const truncated of [frame, scan, Uint8Array.of(...scan, 0xff, 0xd9)]) {
    await assertRejects(() => pdfImage(truncated), Error, "scan data");
  }
});

test("PNG filters reconstruct their neighboring samples", async () => {
  assertEquals([...await pngPixels(readPng(bytes(images.filters)))], [
    3,
    7,
    4,
    10,
    8,
    20,
    10,
    28,
    12,
    33,
  ]);
});

test("document images preserve JPEG bytes, PNG predictors and transparency", async () => {
  for (const name of ["gray", "rgb", "rgba", "grayAlpha", "palette", "packed", "jpeg"] as const) {
    const image = await pdfImage(
      "data:image/" + (name === "jpeg" ? "jpeg" : "png") + ";base64," + images[name],
    );
    assertEquals([image.width, image.height], [2, 1]);
    const item = { image, x: 10, y: 20, width: 30, height: 15 };
    const text = String.fromCharCode(...documentPdf([[item], [item]]));
    assertStringIncludes(text, "q 30 0 0 15 10 807 cm /Im1 Do Q");
    assertEquals((text.match(/\/Im1 Do/g) ?? []).length, 2);
    assertEquals((text.match(/\/Subtype \/Image/g) ?? []).length, image.alpha ? 2 : 1);
    assertStringIncludes(text, "/Filter /" + image.filter);
    if (name === "jpeg") {
      assertEquals(image.data, bytes(images.jpeg));
      assertStringIncludes(text, "/DCTDecode");
    } else if (name === "rgba" || name === "grayAlpha") {
      assertEquals(
        [...await inflate(image.data)],
        name === "rgba" ? [50, 60, 70, 45, 58, 67] : [0, 255],
      );
    } else {
      assertStringIncludes(text, "/Predictor 15");
      assertEquals(image.data, readPng(bytes(images[name])).data);
    }
    if (image.alpha) {
      assertStringIncludes(text, "/SMask ");
      assertEquals(
        [...await inflate(image.alpha)],
        name === "rgba"
          ? [255, 128]
          : name === "grayAlpha"
          ? [64, 128]
          : name === "palette"
          ? [15, 230]
          : [0, 255],
      );
    }
    if (name === "palette" || name === "packed") {
      assertStringIncludes(text, "[/Indexed /DeviceRGB 1 <00000000ff00>]");
    }
    const start = Number(text.match(/startxref\n(\d+)/)![1]);
    assertEquals(text.slice(start, start + 4), "xref");
    [...text.slice(start).matchAll(/^(\d{10}) 00000 n /gm)].forEach(([_, pos], i) =>
      assertStringIncludes(text.slice(+pos, +pos + 12), `${i + 1} 0 obj`)
    );
    for (const m of text.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
      const end = m.index! + m[0].length + Number(m[1]);
      assertEquals(text.slice(end, end + 10), "\nendstream");
    }
  }
  await assertRejects(() => pdfImage(bytes(images.rgba).slice(0, -5)));
});

test("Adam7 interlacing restores packed palette and RGBA pixels before embedding", async () => {
  const palette = await pdfImage(
    bytes(
      "iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFAQMAAAHApoQwAAAABlBMVEUAAAD///+l2Z/dAAAAEUlEQVR4nGNgQAIHwHAFwwoAEnYDkdMg+x8AAAAASUVORK5CYII=",
    ),
  );
  assertEquals([...await inflate(palette.data)], [80, 168, 80, 168, 80]);
  const image = await pdfImage(
    bytes(
      "iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAAH6aBZzAAAAd0lEQVR4nGNgYGRiZhAQFBJmCAgMCk5ITEpm4ODk4maIiIyKZtDQ1NI2MDQytrC0smZgYWVj5+Hl42fQ0dXTNzE1M2cICQ0Lj4mNi2cQERUTl5CUkpaRlZNXUFRSVlFVU2ewsbWzd3B0cnZxdXP38PTy9vH18wcAxOoTVxZnPGwAAAAASUVORK5CYII=",
    ),
  );
  const samples = Array.from({ length: 100 }, (_, i) => i);
  assertEquals([...await inflate(image.data)], samples.filter((i) => i % 4 !== 3));
  assertEquals([...await inflate(image.alpha!)], samples.filter((i) => i % 4 === 3));
});

test("a narrow requested width grows to whole modules including quiet margins", async () => {
  assertEquals(
    readPng(await barcodePng("590123412345", { format: "ean13", width: 100 })).width,
    113,
  );
  const label = { barcode: "SKU-12345", quiet: true, x: 12, y: 0, height: 20 };
  assertEquals(
    documentPdf([[{ ...label, width: 120 }]], { size: "receipt" }),
    documentPdf([[{ ...label, width: 143 }]], { size: "receipt" }),
  );
  assertThrows(
    () => documentPdf([[{ ...label, width: 120 }]], { size: [140, 20] }),
    RangeError,
    "on the page",
  );
});

test("a long Code 128 fits its PNG and PDF when width is omitted", async () => {
  const value = "A".repeat(25);
  const label = { barcode: value, quiet: true, x: 0, y: 0, height: 10 };
  assertEquals(bars(value, undefined, { quiet: true }).width, 330);
  assertEquals(readPng(await barcodePng(value)).width, 330);
  assertEquals(documentPdf([[label]]), documentPdf([[{ ...label, width: 330 }]]));
});

test("an omitted barcode width uses the room from x to the receipt edge", () => {
  const label = { barcode: "A".repeat(25), quiet: true, x: 8, y: 0, height: 10 };
  assertThrows(() => documentPdf([[label]], { size: "receipt" }), RangeError, "on the page");
  // At x=8 the ink ends at 328, and the right quiet margin extends to 338.
  assertThrows(() => documentPdf([[label]], { size: [327, 20] }), RangeError, "on the page");
  assertEquals(
    documentPdf([[label]], { size: [328, 20] }),
    documentPdf([[{ ...label, width: 330 }]], { size: [328, 20] }),
  );
  const small = { ...label, barcode: "POS 12" };
  assertEquals(
    documentPdf([[small]], { size: "receipt" }),
    documentPdf([[{ ...small, width: 219 }]], { size: "receipt" }),
  );
});

test("a Code 128 label fits flush with a fractional page edge", () => {
  const label = { barcode: "POS 12", x: 0, y: 30.1, width: 121, height: 40.2 };
  const pdf = String.fromCharCode(...documentPdf([[label]], { size: [200, 70.3] }));
  assertStringIncludes(pdf, " 0 2 40.2 re f");
  assertThrows(() => documentPdf([[label]], { size: [200, 70.299] }), RangeError, "on the page");
});

test("PDF barcode bounds use the first and last bars, including bars flush with the page", () => {
  const label = { barcode: "POS 12", quiet: true, width: 121, height: 20, y: 0 };
  // rc.63 geometry: ten blank points, then 101 points of ink and gaps.
  for (const x of [-10, -3, 116]) {
    const pdf = String.fromCharCode(...documentPdf([[{ ...label, x }]], { size: "receipt" }));
    assertStringIncludes(pdf, `${x + 10} 12 2 20 re f`);
    assertStringIncludes(pdf, `${x + 109} 12 2 20 re f`);
  }
  for (const x of [-11, 117, 227, 228]) {
    assertThrows(
      () => documentPdf([[{ ...label, x }]], { size: "receipt" }),
      RangeError,
      "on the page",
    );
  }
  for (const y of [-1, 1]) {
    assertThrows(
      () => documentPdf([[{ ...label, x: 0, y }]], { size: [227, 20] }),
      RangeError,
      "on the page",
    );
  }
});
