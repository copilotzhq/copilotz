// deno-lint-ignore-file jsx-key
/**
 * Chat's words on the web: with an app's words set, nothing English of chat's shows; with none,
 * the English reads as it always did; and a second language fills blanks and picks plural forms.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setWords } from "../../../hosts/web/mod.ts";
import { englishLeft, pseudoWords } from "../../../hosts/web/tests/pseudo.ts";
import { test } from "../../../testing/mod.ts";
import { Composer } from "../chat/views/web/composer.tsx";
import { Download } from "../chat/views/web/download.tsx";
import { Header } from "../chat/views/web/header.tsx";
import { Missing } from "../chat/views/web/missing.tsx";
import { Picture } from "../chat/views/web/picture.tsx";
import { Queued } from "../chat/views/web/queued.tsx";
import { Recorder } from "../chat/views/web/recorder.tsx";
import { Retrying } from "../chat/views/web/retrying.tsx";
import { did, Steps } from "../chat/views/web/steps.tsx";
import { Transcript } from "../chat/views/web/transcript.tsx";
import { VoiceFailed } from "../chat/views/web/voice-failed.tsx";
import { VoiceNote } from "../chat/views/web/voice-note.tsx";
import { chatsView } from "../chat/views/web/chats.tsx";
import { homeView } from "../chat/views/web/home.tsx";
import { liveView } from "../chat/views/web/live.tsx";
import { messageView } from "../chat/views/web/message.tsx";
import { chatPaletteView } from "../chat/views/web/palette.tsx";
import { recentView } from "../chat/views/web/recent.tsx";
import { byDay, type Listed } from "../chat/views/web/listed.ts";
import { size } from "../chat/views/web/attach.ts";
import { names } from "../chat/views/web/who.ts";
import { say } from "../chat/views/web/words.ts";

const call = () => Promise.resolve({} as never);
const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

const now = new Date();
const at = now.toISOString();
const thread = (id: string, more: Partial<Listed> = {}): Listed =>
  ({
    _id: id,
    title: "Plan the week",
    at,
    in: "s1",
    agents: ["maya"],
    messages: 3,
    last: "Sounds good",
    ...more,
  }) as Listed;

/** A View context over fake data: whatever is asked of the database answers `rows`. */
// deno-lint-ignore no-explicit-any
const ctx = (rows: any, hints: Record<string, unknown> = {}, extra: any = {}): any => ({
  hints,
  resources: {},
  viewer: { name: "ana", label: "Ana" },
  call,
  show: () => null,
  db: {
    collection: () => ({
      query: () => ({ value: rows }),
      find: () => ({ value: rows }),
      findOne: () => ({ value: rows?.[0] ?? rows }),
    }),
  },
  ...extra,
});

/** Everything chat draws that can be drawn with plain props or a fake context. */
function screens(): ReactNode[] {
  const take = {
    blob: new Blob([]),
    type: "audio/webm",
    name: "v.webm",
    duration: 3000,
    peaks: [],
  };
  const rec = (state: object) =>
    ({ phase: "recording", elapsed: 4000, levels: [], ...state }) as never;
  const voice = { duration: 4000, peaks: [] };
  const msg = (more: object) => ({
    _id: "m1",
    thread: "t1",
    from: "maya",
    to: ["ana"],
    at,
    text: "Hello",
    ...more,
  });
  const messages = [
    msg({ turn: "x", to: ["ana", "bob"], subthread: "t2", stopped: true }),
    msg({ turn: "x", failed: true, text: "" }),
    msg({
      from: "ana",
      to: ["bob"],
      via: { kind: "routine", name: "Morning news" },
      sources: ["Launch"],
      files: [],
    }),
    msg({ turn: "x", toolCalls: [{ id: "c1", name: "clock", output: "9" }], sources: ["Launch"] }),
  ];
  return [
    <Missing fresh="/" />,
    <Download name="plan.pdf" type="application/pdf" size="1.2 MB" href="/f" />,
    <Picture name="cat.png" src="/f" type="image/png" size="2 KB" />,
    <VoiceNote src="/f" name="a.mp3" size="1 KB" transcript="Hi there" />,
    <VoiceNote src="/f" name="a.mp3" size="1 KB" transcript="" voice={voice} mine />,
    <VoiceFailed why="Network" recorded onRetry={() => {}} onAudioOnly={() => {}} />,
    <VoiceFailed why="Network" onRetry={() => {}} onAudioOnly={() => {}} />,
    <Queued thread="t1" agents={[{ id: "maya", name: "Maya" }]} call={call} />,
    <Queued
      thread="t1"
      agents={[{ id: "maya", name: "Maya" }, { id: "bo", name: "Bo" }]}
      call={call}
    />,
    <Retrying
      retry={{ at: new Date(Date.now() + 5000).toISOString(), attempt: 2, reason: "429" }}
    />,
    <Retrying
      retry={{ at: new Date(Date.now() - 5000).toISOString(), attempt: 1, reason: "429" }}
    />,
    <Transcript last="m1" mine>
      <p>hi</p>
    </Transcript>,
    <Recorder state={rec({ phase: "recording" })} onDelete={() => {}} onRestart={() => {}} />,
    <Recorder
      state={rec({ phase: "starting", elapsed: 0 })}
      onDelete={() => {}}
      onRestart={() => {}}
    />,
    <Recorder state={rec({ elapsed: 580_000 })} onDelete={() => {}} onRestart={() => {}} />,
    <Recorder
      state={rec({ phase: "review", take, limited: true })}
      onDelete={() => {}}
      onRestart={() => {}}
    />,
    <Recorder
      state={rec({ phase: "error", error: say("micBusy") })}
      onDelete={() => {}}
      onRestart={() => {}}
    />,
    <Header
      title="Plan the week"
      thread="t1"
      space={{ _id: "s1", name: "Launch", kind: "shared" }}
      people={["Maya", "Ana", "Bo", "Cy", "Di", "Ed"].map((name, i) => ({ name, agent: i < 1 }))}
      fresh="/"
      call={call}
    />,
    <Header
      title="Plan the week"
      thread="t1"
      space={{ _id: "s0", name: "x", kind: "personal" }}
      people={[]}
      fresh="/"
      call={call}
    />,
    <Steps
      calls={[
        { id: "1", name: "clock", input: { tz: "UTC" }, output: "9" },
        { id: "2", name: "send_message", input: { to: "bo" }, output: "ok" },
      ] as never}
      text="Working"
      me="ana"
      named={(id) => id.toUpperCase()}
    />,
    <p>{did([{ name: "send_message", input: { to: "ana" } }, { name: "clock" }], true, "ana")}</p>,
    <Composer
      send={() => Promise.resolve()}
      working={["Maya", "Bo"]}
      agents={[{ id: "maya", name: "Maya" }]}
      where="Launch"
      suggestions={["Draft a reply"]}
      note={<span>{say("startsInPersonal")}</span>}
    />,
    <Composer send={() => Promise.resolve()} working={["Maya"]} />,
    <>{chatsView({ _id: "s1" }, ctx([thread("a"), thread("b", { messages: 1 })]))}</>,
    <>{chatsView({ _id: "s1" }, ctx([]))}</>,
    <>{chatsView({ _id: "s1" }, ctx([thread("a")], { mode: "panel" }))}</>,
    <>{recentView({ _id: "s1" }, ctx([thread("a")]))}</>,
    <>{recentView({ _id: "s1" }, ctx([]))}</>,
    <>
      {homeView(
        {},
        ctx(undefined, { in: "s1" }, {
          db: dbOf({ space: { _id: "s1", name: "Launch", kind: "shared" } }),
        }),
      )}
    </>,
    <>{homeView({}, ctx(undefined, {}))}</>,
    <>{homeView({}, ctx(undefined, { in: "s9" }, { db: dbOf({ space: null }) }))}</>,
    ...messages.map((m) => (
      <>
        {messageView(m as never, ctx(undefined, { thread: "t1", asked: true, queued: ["maya"] }))}
      </>
    )),
    <>
      {liveView(
        { _id: "l", thread: "t2", agent: "maya", at, calls: [], text: "" } as never,
        ctx(undefined, { thread: "t1" }),
      )}
    </>,
    <>
      {liveView(
        {
          _id: "l",
          thread: "t1",
          agent: "maya",
          at,
          calls: [{ id: "c", name: "clock" }],
          text: "",
        } as never,
        ctx(undefined, { thread: "t1" }),
      )}
    </>,
    <>
      {liveView(
        {
          _id: "l",
          thread: "t1",
          agent: "maya",
          at,
          calls: [],
          text: "Hi",
          retry: { at, attempt: 2, reason: "x" },
        } as never,
        ctx(undefined, { thread: "t1" }),
      )}
    </>,
  ];
}

/** A database answering by collection name. */
// deno-lint-ignore no-explicit-any
function dbOf(by: Record<string, any>) {
  return {
    collection: (name: string) => ({
      query: () => ({ value: undefined }),
      find: () => ({ value: [] }),
      findOne: () => ({ value: by[name] }),
    }),
  };
}

const markup = () => screens().map(html).join("\n");

test("with the app's words set, nothing English of chat's shows", () => {
  const restore = setWords(pseudoWords("chat"));
  try {
    const all = markup() + html(
      <Composer send={() => Promise.resolve()} initial="" />,
    ) + paletteWords();
    // Class names, ids and addresses are code, not words.
    const read = all.replace(/ (class|href|id|for|aria-labelledby)="[^"]*"/g, "").replaceAll(
      "send_message",
      "tool",
    );
    assertEquals(englishLeft(read, "chat"), []);
    for (const key of ["send", "newChat", "searchChats", "areWorking"]) {
      assertStringIncludes(all, `«chat.${key}»`);
    }
    assert(/«chat\.greeting\w+Named»/.test(all)); // the greeting follows the hour
    assertStringIncludes(all, "«chat.goesTo»");
    assertStringIncludes(all, "«chat.messageCount»");
    assertStringIncludes(all, "«chat.noChatsTitle»");
  } finally {
    restore();
  }
});

/** The palette's items and steps, as the words they say. */
function paletteWords(): string {
  const groups = chatPaletteView(
    undefined,
    ctx(undefined, { page: { kind: "thread", id: "a" }, in: "s1" }, {
      db: {
        collection: (name: string) => ({
          query: () => ({ value: [thread("a"), thread("b")] }),
          find: () => ({ value: [{ _id: "s1", name: "Launch", kind: "shared" }] }),
          findOne: () => ({ value: name === "thread" ? thread("a") : null }),
        }),
      },
    }) as never,
  );
  // Only what the palette shows: titles, labels, descriptions, keywords, step texts.
  return JSON.stringify(
    groups,
    (key, value) =>
      ["key", "href", "icon", "view", "order", "limit"].includes(key) ? undefined : value,
  );
}

test("with no words set, the English reads as it always did", () => {
  const all = markup();
  for (
    const phrase of [
      "Couldn&#x27;t transcribe your recording, so it wasn&#x27;t sent",
      "Goes to Maya when it&#x27;s done",
      "Goes to Maya and Bo when they&#x27;re done",
      "Stop to send now",
      "Maya and Bo</b> are working…",
      'Messaging <b class="step-who">you</b> · Using <b>clock</b>',
      "Recordings stop at 10 minutes. Listen back, or send it.",
      "No chats here yet",
      "Search 2 chats",
      "Search 1 chat",
      "1 message",
      "3 messages",
      "Good ",
      "Uses <b>Launch</b>. Not everyone here can see it.",
      "Routine: Morning news",
      "Asked in a side thread",
      "This chat isn&#x27;t here",
      "to send",
      "Retrying…",
      "retry 2",
      "Enter</kbd> to send · <kbd",
    ]
  ) assertStringIncludes(all, phrase);
  assertStringIncludes(paletteWords(), "Move this chat to another space…");
  assertEquals(names(["ana", "bob", "cy"]), "ana, bob and cy");
  assertEquals([size(500), size(1536), size(20_480), size(3 * 1_048_576)], [
    "500 B",
    "1.5 KB",
    "20 KB",
    "3.0 MB",
  ]);
  assertEquals(byDay([thread("a")])[0].label, "Today");
});

test("a second language fills blanks and picks plural forms", () => {
  const restore = setWords({
    "chat.searchChats": { one: "Pesquisar {count} conversa", other: "Pesquisar {count} conversas" },
    "chat.messageCount": { one: "{count} mensagem", other: "{count} mensagens" },
    "chat.goesTo": {
      one: "Vai para {names} quando acabar",
      other: "Vão para {names} quando acabarem",
    },
    "chat.namesAnd": "{rest} e {last}",
    "chat.openSpace": "Abrir {space}",
    "chat.workingIn": "No que vamos trabalhar em {space}?",
  });
  try {
    const all = markup();
    assertStringIncludes(all, "Pesquisar 2 conversas");
    assertStringIncludes(all, "Pesquisar 1 conversa");
    assertStringIncludes(all, "1 mensagem");
    assertStringIncludes(all, "3 mensagens");
    assertStringIncludes(all, "Vai para Maya quando acabar");
    assertStringIncludes(all, "Vão para Maya e Bo quando acabarem");
    assertStringIncludes(all, "Abrir Launch");
    assertStringIncludes(all, "No que vamos trabalhar em <b>Launch</b>?");
    assert(!all.includes("«"));
  } finally {
    restore();
  }
});
