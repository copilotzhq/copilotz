// deno-lint-ignore-file jsx-key jsx-boolean-value jsx-curly-braces
/**
 * The web host's, the palette's and the toolkit's words are the app's to change: with every word
 * taken from the table nothing English is left on screen, without words the English is as it
 * was, and a second language reads right (plurals, blanks, dates).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { Loading, Part } from "../part.tsx";
import { Palette } from "../palette/palette.tsx";
import { openPalette } from "../palette/state.ts";
import { AudioPlayer } from "../toolkit/audio-player.tsx";
import { CodeBlock } from "../toolkit/code-block.tsx";
import { CopyButton } from "../toolkit/copy-button.tsx";
import { DetailValue } from "../toolkit/detail-value.tsx";
import { Dialog } from "../toolkit/dialog.tsx";
import { Drawer } from "../toolkit/drawer.tsx";
import { Formula } from "../toolkit/formula.tsx";
import { humanize } from "../toolkit/humanize.ts";
import { InlineEdit } from "../toolkit/inline-edit.tsx";
import { LongText } from "../toolkit/long-text.tsx";
import { Markdown } from "../toolkit/markdown/markdown.tsx";
import { Terminal } from "../toolkit/terminal.tsx";
import { Time } from "../toolkit/time.tsx";
import { ago } from "../toolkit/ago.ts";
import { setWords } from "../words.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";

const areas = ["host", "palette", "toolkit"];

/** A part that has the given output. */
const part = (output: unknown) =>
  ({ subscribe: () => () => {}, get: () => output, close() {} }) as unknown as Parameters<
    typeof Part
  >[0]["part"];

const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");

/** Everything of the three areas that can be drawn on its own. */
function screens(): ReactNode[] {
  const keyed = (nodes: ReactNode[]) => nodes.map((n, i) => <Fragment key={i}>{n}</Fragment>);
  return keyed([
    <Loading />,
    <Part part={part({ status: "failed", error: { code: "forbidden", message: "no" } })} />,
    <Part part={part({ status: "failed", error: new Error("boom") })} />,
    <Palette sources={[]} hints={{}} />,
    <CopyButton text="x" />,
    <LongText text={"word ".repeat(200)} />,
    <CodeBlock code={long} lines={5} />,
    <CodeBlock code={long} lines={5} from="end" />,
    <AudioPlayer />,
    <AudioPlayer src="/a.mp3" duration={65} />,
    <DetailValue value={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]} />,
    <DetailValue value={true} />,
    <DetailValue value={false} />,
    <DetailValue value="abc-123" field="thread_id" />,
    <DetailValue value="2026-11-06" />,
    <DetailValue value={1234567} />,
    <Dialog open={true} onClose={() => {}} title="Ana">body</Dialog>,
    <Drawer open={true} onClose={() => {}} label="Menu">body</Drawer>,
    <Formula tex="x^2" pending />,
    <Formula tex="x^2" />,
    <InlineEdit value="Ana" label="Name" save={async () => {}} done={() => {}} />,
    <Markdown
      text={"- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nlet a = 1\n```"}
    />,
    <Terminal session={undefined as never} />,
    <Time at="2026-11-06T10:00:00Z" />,
  ]);
}

const draw = () => screens().map((screen) => renderToStaticMarkup(screen)).join("\n");

const withLang = (lang: string, run: () => void) => {
  const document = (globalThis as { document?: unknown }).document;
  try {
    Object.assign(globalThis, { document: { documentElement: { lang } } });
    run();
  } finally {
    if (document === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.assign(globalThis, { document });
  }
};

test("with the app's words, no English of the host, palette or toolkit is left", () => {
  const restore = setWords(pseudoWords());
  try {
    openPalette();
    const markup = draw();
    for (const area of areas) assertEquals(englishLeft(markup, area), [], area);
    for (
      const key of [
        "host.loading",
        "host.forbiddenTitle",
        "host.failedTitle",
        "host.reload",
        "palette.nothingYet",
        "palette.commandPalette",
        "palette.cancel",
        "toolkit.copy",
        "toolkit.showMore",
        "toolkit.showEarlierLines",
        "toolkit.showMoreLines",
        "toolkit.items",
        "toolkit.yes",
        "toolkit.no",
        "toolkit.audioPlay",
        "toolkit.terminalOpening",
        "toolkit.close",
        "toolkit.save",
        "toolkit.mathPending",
        "toolkit.copyCode",
        "toolkit.table",
        "toolkit.done",
      ]
    ) assertStringIncludes(markup, `«${key}»`, key);
  } finally {
    restore();
  }
});

test("without words set, the English is as it was", () => {
  const markup = draw();
  for (
    const phrase of [
      "Loading",
      "You can&#x27;t see this here",
      "Something went wrong here",
      "Reload",
      "Nothing here yet",
      "Command palette",
      "Search, or type a command",
      "to move",
      "Show more",
      "Show 25 more lines",
      "Show 25 earlier lines",
      "20 items",
      "Opening the terminal…",
      "Copy",
      "Still being written",
      "Cancel",
    ]
  ) assertStringIncludes(markup, phrase);
  assertEquals(humanize("at"), "When");
});

test("times read in the app's words: plural-aware, dates in the page's language", () => {
  const now = new Date("2026-11-06T12:00:00Z").getTime();
  const at = (seconds: number) => new Date(now - seconds * 1000);
  // English as before.
  assertEquals(ago(at(10), now), "now");
  assertEquals(ago(at(10), now, true), "just now");
  assertEquals(ago(at(300), now), "5m");
  assertEquals(ago(at(60), now, true), "1 minute ago");
  assertEquals(ago(at(300), now, true), "5 minutes ago");
  assertEquals(ago(at(3600), now, true), "1 hour ago");
  assertEquals(ago(at(7200), now), "2h");
  assertEquals(ago(new Date(now + 300_000), now), "in 5m");
  assertEquals(ago(new Date(now + 120_000), now, true), "in 2 minutes");
  const restore = setWords({
    "toolkit.now": "agora",
    "toolkit.justNow": "agora mesmo",
    "toolkit.minutesShort": "{count} min",
    "toolkit.minutesAgo": { one: "há {count} minuto", other: "há {count} minutos" },
    "toolkit.hoursAgo": { one: "há {count} hora", other: "há {count} horas" },
    "toolkit.inMinutes": { one: "em {count} minuto", other: "em {count} minutos" },
    "toolkit.yesterday": "Ontem",
    "toolkit.items": { one: "{count} item", other: "{count} itens" },
  });
  try {
    withLang("pt-BR", () => {
      assertEquals(ago(at(10), now), "agora");
      assertEquals(ago(at(10), now, true), "agora mesmo");
      assertEquals(ago(at(300), now), "5 min");
      assertEquals(ago(at(60), now, true), "há 1 minuto");
      assertEquals(ago(at(300), now, true), "há 5 minutos");
      assertEquals(ago(at(3600), now, true), "há 1 hora");
      assertEquals(ago(new Date(now + 120_000), now, true), "em 2 minutos");
      // A further-off day is written in the page's language.
      const oct = ago(new Date("2026-10-12T12:00:00Z"), now);
      assert(/out/i.test(oct), oct);
      const markup = renderToStaticMarkup(
        <DetailValue value={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]} />,
      );
      assertStringIncludes(markup, "11 itens");
      assertStringIncludes(renderToStaticMarkup(<DetailValue value={1234567} />), "1.234.567");
    });
  } finally {
    restore();
  }
});
