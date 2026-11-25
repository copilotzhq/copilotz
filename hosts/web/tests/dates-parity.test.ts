// Expected date-only readings from hosts/web/toolkit/dates.ts at 2383779c (rc.63).
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { formatPattern, parsePattern } from "../toolkit/dates.ts";

for (const locale of ["en-US", "pt-BR", "fr-FR", "ja-JP", "ar-EG"]) {
  test("rc.63 date patterns and literal separators in " + locale, () => {
    for (
      const [pattern, input, expected] of [
        ["dd/MM/yyyy", "12/11/2026", "2026-11-12"],
        ["MM/dd/yyyy", "11/12/2026", "2026-11-12"],
        ["yyMMdd", "261112", "2026-11-12"],
        ["yyyyMMdd", "20261112", "2026-11-12"],
        ["dd.MM.yy", "12.11.26", "2026-11-12"],
        ["dd.MM.yy", "12.11.2026", undefined],
        ["d MMM yyyy", "12 xyz 2026", undefined],
        ["dd/MM/'lot,  1'/yyyy", "01/02/lot,  1/2026", "2026-02-01"],
        ["dd/MM/'lot,  1'/yyyy", "01/02/lot1/2026", undefined],
        ["dd/MM/'lot,  1'/yyyy", "01/02/lot  1/2026", undefined],
        ["dd/MM/'lot,  1'/yyyy", "01/02/lot, 1/2026", undefined],
        ["MMM d, yyyy", "Nov 12 2026", undefined],
      ] as const
    ) {
      assertEquals(parsePattern(input, pattern, locale), expected, pattern + " reading " + input);
    }
  });
}

test("localized short months retain rc.63 readings and support Japanese numeric months", () => {
  for (
    const [locale, input] of [
      ["en-US", "12 Nov 2026"],
      ["pt-BR", "12 nov. 2026"],
      ["fr-FR", "12 nov. 2026"],
      ["ar-EG", "12 نوفمبر 2026"],
      // rc.63 returned undefined for its own formatted Japanese month.
      ["ja-JP", "12 11 2026"],
    ]
  ) {
    assertEquals(parsePattern(input, "d MMM yyyy", locale), "2026-11-12", locale);
  }
});

test("a Japanese numeric month name needs a separator from adjacent digits", () => {
  const pattern = "yyyyMMMd";
  const compact = formatPattern("2026-11-02", pattern, "ja-JP");
  assertEquals(compact, "2026112");
  assertEquals(parsePattern(compact, pattern, "ja-JP"), undefined);
  assertEquals(parsePattern("202692", pattern, "ja-JP"), undefined);
  assertEquals(parsePattern("2026/11/2", "yyyy/MMM/d", "ja-JP"), "2026-11-02");
});
