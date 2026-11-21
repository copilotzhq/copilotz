/**
 * Files on a computer's page, on the web, and files an agent moves between a chat and a
 * computer. The Files tab offers uploading (its button, and taking files dropped on it) only
 * where the person changes files, and says why elsewhere; what's dropped there shows where it'd
 * go. Uploads (driven through a fake of the browser's request) go up in parts of up to 8 MiB,
 * each a `PUT` to the route, under the app's base, saying the desk, the path, the attempt's id,
 * the part's offset and the whole size; they show their bytes and share (across parts), the
 * computer waking, finishing, and when each is there; a part refused is its file's error. A name that's taken asks first:
 * replaced (sent again with `replace=1`), both kept, or skipped, for the rest of the batch too;
 * a folder there is never replaced. Refusals are said plainly, and folders dropped aren't
 * uploaded, saying so. Drawn as the server would, through React's own renderer; and in the app's
 * words, nothing English left.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import { setWords } from "../../../hosts/web/words.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
import type { Entry } from "../computers/shared/workloads.ts";
import { FilesTab } from "../computers/views/web/files.tsx";
import { stepView } from "../computers/views/web/step.tsx";
import {
  AskReplace,
  DropTarget,
  failureOf,
  FoldersDropped,
  UploadTray,
} from "../computers/views/web/upload-tray.tsx";
import {
  type Answer,
  answerOf,
  carriesFiles,
  droppedOf,
  freeName,
  MOST,
  PART,
  phaseOf,
  type Send,
  uploader,
  uploadUrl,
} from "../computers/views/web/uploads.ts";
import { test } from "../../../testing/mod.ts";

const draw = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const MB = 1024 * 1024;
/** A file of `size` bytes (its bytes aren't read: only its name and size). */
const fileOf = (name: string, size = 10) => new File([new Uint8Array(size)], name);

/** The browser's request, faked: what was sent where, its progress and answer given by the test. */
function fakeSend() {
  const sent: {
    url: URL;
    file: Blob;
    progress(loaded: number, total: number): void;
    answer(answer: Answer): void;
    aborted: boolean;
  }[] = [];
  const send: Send = ({ url, file, progress }) => {
    const { promise, resolve } = Promise.withResolvers<Answer>();
    const one = {
      url: new URL(url, "https://app.test"),
      file,
      progress,
      answer: resolve,
      aborted: false,
    };
    sent.push(one);
    return {
      abort: () => {
        one.aborted = true;
        resolve({ ok: false, status: 0, code: "cancelled" });
      },
      answer: promise,
    };
  };
  return { sent, send };
}

/** Lets answers land (and progress be told). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 120));

/** What people read of markup: its text, and the attributes said aloud or shown on hover. */
const readable = (html: string) =>
  [
    text(html),
    ...[...html.matchAll(/ (?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map(([, said]) =>
      said
    ),
  ].join("\n");

const noop = () => {};
const workNone = (() => Promise.resolve({ entries: [] })) as never;

test("the Files tab offers uploading only where the person changes files, and says why elsewhere", () => {
  const mine = draw(
    <FilesTab work={workNone} folder="acme" computer="Mac" desk="d1" />,
  );
  assertStringIncludes(mine, ">Upload<");
  assertStringIncludes(mine, ">New file<");
  assertStringIncludes(mine, 'type="file"');
  assertStringIncludes(mine, "multiple");
  // It takes files dropped on it.
  assertStringIncludes(mine, 'data-drop=""');
  assert(!text(mine).includes("Only "), "nothing said where they may");

  // Where its owner answers for it: no uploading, no new file, no drop; and why.
  const theirs = draw(
    <FilesTab work={workNone} folder="acme" computer="Mac" desk="d1" writes={false} owner="Bea" />,
  );
  assert(!theirs.includes(">Upload<"));
  assert(!theirs.includes(">New file<"));
  assert(!theirs.includes('type="file"'));
  assert(!theirs.includes("data-drop"));
  assertStringIncludes(
    text(theirs),
    "Only Bea changes files on Mac here. You can open and download them.",
  );
  assertStringIncludes(
    text(draw(<FilesTab work={workNone} folder="acme" computer="Mac" desk="d1" writes={false} />)),
    "Only its owner changes files on Mac here.",
  );

  // While files are dragged over it, where they'd go: only files, not text or a link.
  assertEquals(
    text(draw(<DropTarget folder="acme/src" computer="Mac" />)),
    [
      "Drop to upload",
      "To acme/src on Mac",
    ].join(" "),
  );
  assert(carriesFiles(["Files", "application/x-moz-file"]));
  assert(!carriesFiles(["text/plain", "text/uri-list"]));
  assert(!carriesFiles(undefined));
});

test("an upload goes up as a PUT of the file, to the route under the app's base, showing its progress and when it's there", async () => {
  const { sent, send } = fakeSend();
  const finished: string[] = [];
  let now = 0;
  const uploads = uploader({
    desk: "desk 1",
    base: () => "https://app.test/o/acme",
    send,
    now: () => now,
    finished: (u) => finished.push(`${u.folder.join("/")}/${u.name}`),
  });
  const file = fileOf("my report.pdf", 4 * MB);
  uploads.add([file], ["src"], []);

  assertEquals(sent.length, 1);
  const [one] = sent;
  assertEquals(one.url.origin + one.url.pathname, "https://app.test/o/acme/computers/upload");
  assertEquals(one.url.searchParams.get("desk"), "desk 1");
  assertEquals(one.url.searchParams.get("path"), "src/my report.pdf");
  assertEquals(one.url.searchParams.has("replace"), false);
  // Under 8 MiB, it's one part: all of it, from the start, of its whole size, under its attempt's id.
  assertEquals(one.url.searchParams.get("offset"), "0");
  assertEquals(one.url.searchParams.get("total"), String(4 * MB));
  assertMatch(one.url.searchParams.get("upload")!, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assertEquals(one.file.size, file.size);
  assertEquals(
    uploadUrl("", "d1", "a/b c.txt", { upload: "u1", offset: 8, total: 20, replace: true }),
    "/computers/upload?desk=d1&path=a%2Fb+c.txt&upload=u1&offset=8&total=20&replace=1",
  );

  const tray = () =>
    draw(
      <UploadTray
        uploader={uploads}
        computer="Mac"
        folder="acme"
        path={["src"]}
        clock={() => now}
        open={(u) => u.name === "my report.pdf" ? noop : undefined}
      />,
    );
  // Bytes moving: how far, of how much, and its share; the batch's too.
  now = 300;
  one.progress(1 * MB, 4 * MB);
  now = 1200;
  one.progress(1 * MB + 512 * 1024, 4 * MB);
  let shown = text(tray());
  assertStringIncludes(shown, "Uploading 1 file");
  assertStringIncludes(shown, "1.5 MB of 4 MB · 37%");
  assertStringIncludes(shown, "2.5 MB left · 37%");
  assertStringIncludes(tray(), 'aria-valuenow="37"');
  assertStringIncludes(tray(), 'aria-label="Cancel uploading my report.pdf"');

  // There: the tray says so, it opens from there, and the listing is told.
  one.answer({ ok: true, path: "src/my report.pdf", size: 4 * MB });
  await settled();
  shown = text(tray());
  assertStringIncludes(shown, "1 file uploaded");
  assertStringIncludes(shown, "Uploaded · 4 MB");
  assertStringIncludes(tray(), 'title="Open my report.pdf"');
  assertStringIncludes(tray(), 'aria-label="Hide uploads"');
  assertEquals(finished, ["src/my report.pdf"]);

  // Another batch, once that one's over, starts the list again.
  uploads.add([fileOf("next.txt")], ["src"], []);
  assertEquals(uploads.uploads().map((u) => u.name), ["next.txt"]);
  sent[1].answer({ ok: true, path: "src/next.txt", size: 10 });
  await settled();
  // Hidden, it's gone.
  uploads.clear();
  assertEquals(tray(), "");
});

test("a file over 8 MiB goes up in parts, in order, under one id; its progress sums them; a later part's refusal is its error", async () => {
  const { sent, send } = fakeSend();
  let now = 0;
  const uploads = uploader({ desk: "d1", send, now: () => now });
  const bytes = new Uint8Array(20 * MB);
  [bytes[PART], bytes[2 * PART]] = [7, 9];
  uploads.add([new File([bytes], "video.mp4")], ["clips"], []);
  const q = (i: number) => sent[i].url.searchParams;
  const first = async (i: number) =>
    new Uint8Array(await sent[i].file.slice(0, 1).arrayBuffer())[0];
  const tray = () =>
    text(draw(
      <UploadTray
        uploader={uploads}
        computer="Mac"
        folder="acme"
        path={["clips"]}
        clock={() => now}
      />,
    ));

  // The first part: 8 MiB from the start, saying the whole size.
  assertEquals(sent.length, 1);
  assertEquals([q(0).get("path"), q(0).get("offset"), q(0).get("total")], [
    "clips/video.mp4",
    "0",
    String(20 * MB),
  ]);
  assertEquals(sent[0].file.size, PART);
  const id = q(0).get("upload")!;
  now = 300;
  sent[0].progress(4 * MB, PART);
  assertStringIncludes(tray(), "4 MB of 20 MB · 20%");
  sent[0].answer({ ok: true, received: PART });
  await settled();

  // The next, only once the first is in: from 8 MiB, the same id; progress counts the first too.
  assertEquals(sent.length, 2);
  assertEquals([q(1).get("offset"), q(1).get("upload"), q(1).get("total")], [
    String(PART),
    id,
    String(20 * MB),
  ]);
  assertEquals([sent[1].file.size, await first(1)], [PART, 7]);
  now = 1400;
  sent[1].progress(2 * MB, PART);
  assertStringIncludes(tray(), "10 MB of 20 MB · 50%");
  assertStringIncludes(tray(), "10 MB left · 50%");
  sent[1].answer({ ok: true, received: 2 * PART });
  await settled();

  // The last: what's left, from 16 MiB. Refused there, it's the file's error; it can go again.
  assertEquals([q(2).get("offset"), q(2).get("upload"), sent[2].file.size, await first(2)], [
    String(2 * PART),
    id,
    4 * MB,
    9,
  ]);
  sent[2].answer({ ok: false, status: 503, code: "offline" });
  await settled();
  assertEquals(uploads.uploads()[0].state, "failed");
  assertStringIncludes(tray(), "Mac is offline. Try again once it's on.");
  assertStringIncludes(tray(), "1 didn't upload");
  assertStringIncludes(tray(), "Try again");

  // Tried again, it starts over: from the first byte, under a new id.
  uploads.retry(uploads.uploads()[0].id);
  assertEquals(sent.length, 4);
  assertEquals(q(3).get("offset"), "0");
  const second = q(3).get("upload")!;
  assert(second !== id);
  sent[3].answer({ ok: true, received: PART });
  await settled();
  assertEquals([q(4).get("offset"), q(4).get("upload")], [String(PART), second]);
  // A later part the computer lost track of: it has to start again, and says so.
  sent[4].answer({ ok: false, status: 400, code: "invalid", message: "No upload by that id." });
  await settled();
  assertStringIncludes(tray(), "This upload was interrupted and has to start again.");

  // Cancelled midway: the part on its way stops, and no more go.
  uploads.retry(uploads.uploads()[0].id);
  sent[5].answer({ ok: true, received: PART });
  await settled();
  assertEquals(sent.length, 7);
  uploads.cancel(uploads.uploads()[0].id);
  assert(sent[6].aborted);
  await settled();
  assertEquals(sent.length, 7);
  assertStringIncludes(tray(), "Cancelled");

  // A file that appeared there meanwhile is said on the last part: replaced, it starts over,
  // with replace=1 on every part.
  const more = fakeSend();
  const late = uploader({ desk: "d1", send: more.send });
  late.add([fileOf("disk.img", PART + MB)], [], []);
  more.sent[0].answer({ ok: true, received: PART });
  await settled();
  more.sent[1].answer({ ok: false, status: 409, code: "exists" });
  await settled();
  assertEquals(late.uploads()[0].state, "asking");
  late.answer(late.uploads()[0].id, "replace");
  more.sent[2].answer({ ok: true, received: PART });
  await settled();
  const replaced = more.sent.slice(2).map((s) => s.url.searchParams);
  assertEquals(replaced.map((r) => [r.get("offset"), r.get("replace")]), [
    ["0", "1"],
    [String(PART), "1"],
  ]);
  assertEquals(replaced[0].get("upload"), replaced[1].get("upload"));
  assert(replaced[0].get("upload") !== more.sent[0].url.searchParams.get("upload"));
  more.sent[3].answer({ ok: true, path: "disk.img", size: PART + MB });
  await settled();
  assertEquals(late.uploads()[0].state, "done");
});

test("a computer waking, or awaited, before its bytes move; and finishing once all are sent", () => {
  const { sent, send } = fakeSend();
  let now = 0;
  const uploads = uploader({ desk: "d1", send, now: () => now });
  uploads.add([fileOf("big.zip", 8 * MB)], [], []);
  const tray = (sleeps?: boolean) =>
    text(draw(
      <UploadTray
        uploader={uploads}
        computer="Builder"
        sleeps={sleeps}
        folder="acme"
        path={[]}
        clock={() => now}
      />,
    ));
  // The first burst goes into the network's buffers; then nothing moves.
  now = 50;
  sent[0].progress(256 * 1024, 8 * MB);
  now = 400;
  assertEquals(phaseOf(uploads.uploads()[0], now), "sending");
  now = 2500;
  assertEquals(phaseOf(uploads.uploads()[0], now), "waking");
  assertStringIncludes(tray(true), "Waking Builder…");
  assertStringIncludes(tray(false), "Waiting for Builder…");
  // Awake: bytes move again, and keep moving.
  now = 9000;
  sent[0].progress(4 * MB, 8 * MB);
  now = 9400;
  assertStringIncludes(tray(true), "4 MB of 8 MB · 50%");
  // All sent, and the computer still writing it.
  now = 9600;
  sent[0].progress(8 * MB, 8 * MB);
  now = 12_000;
  assertStringIncludes(tray(true), "Saving on Builder…");
  uploads.cancelAll();
  assert(sent[0].aborted);
});

test("a name that's taken asks first: replaced with replace=1, kept beside it, or skipped, for the rest of the batch too", async () => {
  const { sent, send } = fakeSend();
  const uploads = uploader({ desk: "d1", send });
  const listed: Entry[] = [
    { name: "a.txt", type: "file", size: 2048, mtime: "2026-11-20T10:00:00.000Z" },
    { name: "a 2.txt", type: "file", size: 10, mtime: "2026-11-20T10:00:00.000Z" },
  ];
  uploads.add([fileOf("a.txt"), fileOf("b.txt"), fileOf("c.txt")], ["notes"], listed);
  // The listing says a.txt is there: it waits; the others go.
  assertEquals(sent.map((s) => s.url.searchParams.get("path")), ["notes/b.txt", "notes/c.txt"]);
  // The computer says b.txt is there too (the listing was behind).
  sent[0].answer({ ok: false, status: 409, code: "exists", message: "There's a file there." });
  sent[1].answer({ ok: true, path: "notes/c.txt", size: 10 });
  await settled();
  assertEquals(
    uploads.uploads().map((u) => u.state),
    ["asking", "asking", "done"],
  );

  const asked = draw(<AskReplace uploader={uploads} folder="acme" />);
  const said = text(asked);
  assertStringIncludes(said, "Replace “a.txt”?");
  assertStringIncludes(said, "acme/notes already has a file named “a.txt”.");
  assertStringIncludes(said, "The one there: 2 KB, changed");
  assertStringIncludes(said, "Yours: 10 B, changed");
  // Keeping both picks a name that's free, past "a 2.txt".
  assertStringIncludes(said, "Keep both uploads yours as “a 3.txt”.");
  assertStringIncludes(said, "Do the same for the other file that's already there");
  for (const button of [">Skip<", ">Keep both<", ">Replace<"]) assertStringIncludes(asked, button);
  assertStringIncludes(
    text(draw(<UploadTray uploader={uploads} computer="Mac" folder="acme" path={["notes"]} />)),
    "1 file uploaded · 2 wait for you",
  );

  // Replace, for both: each goes again with replace=1, from the start, b.txt under a new id.
  const first = sent[0].url.searchParams.get("upload");
  uploads.answer(uploads.uploads()[0].id, "replace", true);
  const again = sent.slice(2).map((s) => s.url.searchParams);
  assertEquals(again.map((q) => [q.get("path"), q.get("replace"), q.get("offset")]), [
    ["notes/a.txt", "1", "0"],
    ["notes/b.txt", "1", "0"],
  ]);
  assert(again[1].get("upload") !== first);
  sent[2].answer({ ok: true, path: "notes/a.txt", size: 10 });
  sent[3].answer({ ok: true, path: "notes/b.txt", size: 10 });
  await settled();
  assertStringIncludes(
    text(draw(<UploadTray uploader={uploads} computer="Mac" folder="acme" path={["notes"]} />)),
    "Uploaded in place of the one there",
  );
  assertEquals(draw(<AskReplace uploader={uploads} folder="acme" />), "");

  // Kept beside it, under a free name; skipped, it can ask again.
  const more = fakeSend();
  const second = uploader({ desk: "d1", send: more.send });
  second.add([fileOf("a.txt"), fileOf("report.tar.gz")], [], [
    ...listed,
    { name: "report.tar.gz", type: "file", size: 1, mtime: "2026-11-20T10:00:00.000Z" },
  ]);
  const [a, report] = second.uploads();
  second.answer(a.id, "keep");
  assertEquals(more.sent[0].url.searchParams.get("path"), "a 3.txt");
  assertEquals(more.sent[0].url.searchParams.has("replace"), false);
  second.answer(report.id, "skip");
  assertEquals(second.uploads()[1].state, "skipped");
  more.sent[0].answer({ ok: true, path: "a 3.txt", size: 10 });
  await settled();
  const shown = text(draw(<UploadTray uploader={second} computer="Mac" folder="acme" path={[]} />));
  assertStringIncludes(shown, "Uploaded as a 3.txt");
  assertStringIncludes(shown, "Skipped: the one there stays");
  second.retry(report.id);
  assertEquals(second.uploads()[1].state, "asking");

  // A folder by that name is never replaced: keep both, or skip.
  const third = uploader({ desk: "d1", send: fakeSend().send });
  third.add([fileOf("src")], [], [
    { name: "src", type: "directory", size: 0, mtime: "2026-11-20T10:00:00.000Z" },
  ]);
  const folder = draw(<AskReplace uploader={third} folder="acme" />);
  assertStringIncludes(text(folder), "There's a folder named “src”");
  assertStringIncludes(text(folder), "A file can't replace a folder.");
  assert(!folder.includes(">Replace<"));
  third.answer(third.uploads()[0].id, "replace");
  assertEquals(third.uploads()[0].state, "asking");

  // Sent to replace, and the computer still says it's there: it's a folder.
  const fourth = fakeSend();
  const late = uploader({ desk: "d1", send: fourth.send });
  late.add([fileOf("lib")], [], []);
  fourth.sent[0].answer({ ok: false, status: 409, code: "exists" });
  await settled();
  late.answer(late.uploads()[0].id, "replace");
  assertEquals(fourth.sent[1].url.searchParams.get("replace"), "1");
  fourth.sent[1].answer({ ok: false, status: 409, code: "exists" });
  await settled();
  assertEquals(late.uploads()[0].there?.type, "directory");
  assertStringIncludes(text(draw(<AskReplace uploader={late} folder="acme" />)), "a folder named");

  assertEquals(freeName("report.pdf", ["Report 2.PDF"]), "report 3.pdf");
  assertEquals(freeName("report 2.pdf", []), "report 3.pdf");
  assertEquals(freeName(".env", []), ".env 2");
  assertEquals(freeName("Makefile", ["Makefile 2"]), "Makefile 3");
});

test("a refusal is said plainly, in the route's words where they say more; cancelled or failed, it can go again", async () => {
  const { sent, send } = fakeSend();
  const uploads = uploader({ desk: "d1", send });
  const tray = (sleeps?: boolean) =>
    text(draw(
      <UploadTray uploader={uploads} computer="Mac" sleeps={sleeps} folder="acme" path={[]} />,
    ));

  // Too large for the route: refused before a byte is sent.
  uploads.add([{ name: "disk.img", size: MOST + MOST / 2, lastModified: 0 } as File], [], []);
  assertEquals(sent.length, 0);
  assertStringIncludes(tray(), "It's 3 GB: a file can be 2 GB at most.");

  uploads.add(
    [fileOf("one.txt"), fileOf("two.txt"), fileOf("three.txt"), fileOf("four.txt")],
    [],
    [],
  );
  // Three at a time.
  assertEquals(sent.length, 3);
  sent[0].answer({
    ok: false,
    status: 403,
    code: "forbidden",
    message: "Its owner keeps this computer's answers: only they work on it directly.",
  });
  sent[1].answer({ ok: false, status: 503, code: "offline", message: "The computer is offline." });
  sent[2].answer({ ok: false, status: 0, code: "network" });
  await settled();
  let shown = tray(true);
  assertStringIncludes(
    shown,
    "Its owner keeps this computer's answers: only they work on it directly.",
  );
  assertStringIncludes(shown, "Mac didn't wake up in time. Try again.");
  assertStringIncludes(tray(false), "Mac is offline. Try again once it's on.");
  assertStringIncludes(shown, "The connection dropped. Try again.");
  assertStringIncludes(shown, "4 didn't upload");
  // The fourth went once a place was free; cancelled, it stops its request.
  assertEquals(sent.length, 4);
  const four = uploads.uploads().find((u) => u.name === "four.txt")!;
  uploads.cancel(four.id);
  assert(sent[3].aborted);
  await settled();
  shown = tray();
  assertStringIncludes(shown, "Cancelled");
  assertStringIncludes(shown, "Try again");

  // Tried again, it goes again.
  const offline = uploads.uploads().find((u) => u.name === "two.txt")!;
  uploads.retry(offline.id);
  assertEquals(sent.length, 5);
  assertEquals(sent[4].url.searchParams.get("path"), "two.txt");
  sent[4].answer({ ok: true, path: "two.txt", size: 10 });
  await settled();

  // What a response says: the route's JSON (a part received, or the file there), or a proxy's
  // status alone.
  assertEquals(answerOf(200, '{"received":8388608}'), { ok: true, received: 8388608 });
  assertEquals(answerOf(200, '{"path":"a/b.txt","size":12}'), {
    ok: true,
    path: "a/b.txt",
    size: 12,
  });
  assertEquals(
    answerOf(501, '{"error":{"message":"Too old.","code":"outdated"}}'),
    { ok: false, status: 501, code: "outdated", message: "Too old." },
  );
  assertEquals(answerOf(413, "<html>Request Entity Too Large</html>"), {
    ok: false,
    status: 413,
    code: "too_large_here",
  });
  assertEquals(answerOf(502, ""), { ok: false, status: 502 });
  const proxy = uploader({ desk: "d1", send: fakeSend().send });
  proxy.add([fileOf("video.mp4", 3 * MB)], [], []);
  const words = (code: string, message?: string) =>
    failureOf({
      ...proxy.uploads()[0],
      state: "failed",
      refused: { ok: false, status: 400, code, ...(message ? { message } : {}) },
    }, { computer: "Mac" }).text;
  assertStringIncludes(words("too_large_here"), "It's 3 MB: too large to send through this app.");
  assertStringIncludes(words("outdated"), "Mac's computer program is too old to take uploads.");
  assertStringIncludes(words("full"), "There's no room left on Mac's disk.");
  assertStringIncludes(words("unauthorized"), "You're signed out. Sign in again, then try again.");
  assertStringIncludes(words("not_found"), "This computer isn't in this space anymore.");
  assertEquals(
    words("invalid_path", '".." climbs out of the folder'),
    "That name can't be used here.",
  );
  assertStringIncludes(words("teapot"), "It didn't upload. Try again.");
  proxy.cancelAll();
  await settled();
});

test("folders dropped aren't uploaded, and it says so; the files beside them go", () => {
  const entry = (name: string, isDirectory: boolean) => ({ name, isDirectory });
  const item = (file: File, directory = false) => ({
    kind: "file",
    getAsFile: () => directory ? null : file,
    webkitGetAsEntry: () => entry(file.name, directory),
  });
  const notes = fileOf("notes.md");
  const zip = fileOf("photos.zip");
  const dropped = droppedOf({
    files: [] as unknown as FileList,
    items: [
      item(notes),
      item(fileOf("photos"), true),
      item(zip),
      { kind: "string" },
    ] as unknown as DataTransferItemList,
  });
  assertEquals(dropped.files, [notes, zip]);
  assertEquals(dropped.folders, ["photos"]);
  // No items (an older browser): its files, as they are.
  assertEquals(droppedOf({ files: [notes] as unknown as FileList }).files, [notes]);

  const one = text(draw(<FoldersDropped names={["photos"]} close={noop} />));
  assertEquals(
    one,
    "“photos” is a folder, and folders can't be uploaded. Drop the files in it, or a zip of it.",
  );
  assertStringIncludes(
    text(draw(<FoldersDropped names={["a", "b"]} close={noop} />)),
    "2 folders weren't uploaded",
  );
});

/** A View's context over nothing: the step reads no data. */
const stepCtx = (hints: Record<string, unknown> = {}) =>
  ({
    db: {},
    resources: {},
    name: "test",
    viewer: { name: "ana" },
    hints,
    show: () => null,
    call: () => Promise.resolve({} as never),
    emit: () => Promise.resolve(),
  }) as unknown as ViewContext<ReactNode>;

test("an agent's save_file and send_file, as people read them: what moved where, its size, and why not", () => {
  const step = (name: string, input: Record<string, unknown>, output?: unknown, running = false) =>
    draw(stepView(
      {
        name,
        input,
        ...(output === undefined
          ? {}
          : { output: typeof output === "string" ? output : JSON.stringify(output) }),
      } as never,
      stepCtx(running ? { running: true } : {}),
    ));

  // Saved from the chat to the folder: the file as sent (a link to it), where, and its size there.
  const saved = step("save_file", { file: "file-1", path: "work/data.zip" }, {
    path: "work/data.zip",
    size: 2048,
    file: "data.zip",
  });
  assertEquals(text(saved), "Saved data.zip to work/data.zip 2.0 KB");
  assertStringIncludes(saved, 'href="/files/file-1"');
  // Waiting on its person's yes: what it would save, where.
  assertStringIncludes(
    text(step(
      "save_file",
      { file: "file-1" },
      "Waiting for ana's yes to change files on their computer: save data.zip as data.zip",
    )),
    "Saves data.zip to data.zip asked you first",
  );
  assertStringIncludes(
    text(step("save_file", { file: "file-1", path: "in/x.csv" }, undefined, true)),
    "Saves a file from this chat to in/x.csv running",
  );
  const missing = text(step(
    "save_file",
    { file: "file-9" },
    'Error: there\'s no file "file-9" here: give the id its message shows (file-…).',
  ));
  assertStringIncludes(missing, "Saves a file from this chat in the space's folder failed");
  assertStringIncludes(missing, 'there\'s no file "file-9" here');
  // Where the space has several computers, the one it went to.
  assertStringIncludes(
    step("save_file", { file: "file-1" }, {
      path: "data.zip",
      size: 10,
      file: "data.zip",
      computer: "builder",
    }),
    "builder",
  );

  // Sent into the chat (the chat shows the file, as the agent's message): which, and its size.
  assertEquals(
    text(step("send_file", { path: "out/report.pdf" }, {
      sent: "report.pdf",
      path: "out/report.pdf",
      size: 1258291,
      message: "m1",
    })),
    "Sent report.pdf 1.2 MB",
  );
  const big = text(step(
    "send_file",
    { path: "out/video.mp4" },
    "Error: out/video.mp4 is 48.0 MB: a file sent in a chat can be about 10 MB at most.",
  ));
  assertStringIncludes(big, "Sends out/video.mp4 to this chat failed");
  assertStringIncludes(big, "a file sent in a chat can be about 10 MB at most");
});

test("the Files tab, its uploads and the file steps take every word from the app's", async () => {
  const restore = setWords({ ...pseudoWords("computers"), ...pseudoWords("toolkit") });
  try {
    const { sent, send } = fakeSend();
    const uploads = uploader({ desk: "d1", send });
    uploads.add([fileOf("a.txt"), fileOf("b.txt"), fileOf("c.txt")], [], [
      { name: "a.txt", type: "file", size: 1, mtime: "2026-11-20T10:00:00.000Z" },
    ]);
    sent[0].progress(5, 10);
    sent[1].answer({ ok: false, status: 503, code: "offline" });
    await settled();
    const markup = [
      draw(<FilesTab work={workNone} folder="acme" computer="Mac" desk="d1" />),
      draw(<FilesTab work={workNone} folder="acme" computer="Mac" desk="d1" writes={false} />),
      draw(<UploadTray uploader={uploads} computer="Mac" folder="acme" path={["x"]} />),
      draw(<AskReplace uploader={uploads} folder="acme" />),
      draw(<DropTarget folder="acme" computer="Mac" />),
      draw(<FoldersDropped names={["photos"]} close={noop} />),
      draw(stepView(
        {
          name: "save_file",
          input: { file: "f1" },
          output: JSON.stringify({ path: "a.zip", size: 1, file: "a.zip" }),
        } as never,
        stepCtx(),
      )),
      draw(stepView(
        {
          name: "send_file",
          input: { path: "a.zip" },
          output: JSON.stringify({ sent: "a.zip", path: "a.zip", size: 1, message: "m" }),
        } as never,
        stepCtx(),
      )),
    ].join("\n");
    assertEquals(englishLeft(readable(markup), "computers"), []);
    uploads.cancelAll();
    await settled();
  } finally {
    restore();
  }
});
