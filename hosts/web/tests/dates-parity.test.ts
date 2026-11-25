// Expected date-only readings from hosts/web/toolkit/dates.ts at 2383779c (rc.63).
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { parsePattern } from "../toolkit/dates.ts";

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

test("localized short month names retain rc.63 readings", () => {
  for (
    const [locale, input] of [
      ["en-US", "12 Nov 2026"],
      ["pt-BR", "12 nov. 2026"],
      ["fr-FR", "12 nov. 2026"],
      ["ar-EG", "12 نوفمبر 2026"],
    ]
  ) {
    assertEquals(parsePattern(input, "d MMM yyyy", locale), "2026-11-12", locale);
  }
});

// rc.63 accepts only letters and an optional trailing dot for a month name.
// Check both sides of the day, with and without a separator, including names with a suffix.
for (const [locale, month] of [["zh-CN", "11月"], ["ko-KR", "11월"], ["ja-JP", "11"]]) {
  test("rc.63 rejects digit-containing month names in " + locale, () => {
    for (
      const [pattern, input] of [
        ["yyyy/dMMM", "2026/2" + month],
        ["yyyy/MMMd", "2026/" + month + "2"],
        ["yyyy/d/MMM", "2026/2/" + month],
        ["yyyy/MMM/d", "2026/" + month + "/2"],
      ]
    ) {
      assertEquals(parsePattern(input, pattern, locale), undefined, pattern + " reading " + input);
    }
  });
}

test("rc.63 numeric date fields require ASCII digits even in a locale with Arabic digits", () => {
  const locale = "ar-EG-u-nu-arab";
  assertEquals(parsePattern("02/11/2026", "dd/MM/yyyy", locale), "2026-11-02");
  assertEquals(parsePattern("٠٢/١١/٢٠٢٦", "dd/MM/yyyy", locale), undefined);
});
