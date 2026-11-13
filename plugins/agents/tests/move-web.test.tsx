/**
 * Moving a chat on the web: picking a space asks first, saying who'll see
 * the whole conversation there and what it drew on, and moves only on
 * "Move to …" ("Keep it where it is" goes back to the spaces). What it says:
 * a space's people (one person, or many), the spaces it drew on (yours, or
 * someone's Personal one by its person), and how many more it drew on that
 * the person moving it doesn't reach; into their own Personal space, only
 * they will see it.
 */
import { assert, assertEquals } from "@std/assert";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LazyView, type PaletteControl, type PaletteStep } from "../../../hosts/web/mod.ts";
import { test } from "../../../testing/mod.ts";
import type { Moving } from "../chat/collections/thread.ts";
import { moveStep } from "../chat/views/web/move.tsx";
import { movingView } from "../chat/views/web/moving.tsx";

const ME = "sam";
const launch = { _id: "s2", name: "Launch", kind: "shared" };

/** What moving to a space says, as Sam reads it, when `thread.moving` answers `moving`. */
function said(moving: Moving | null): string {
  const ctx = {
    name: "chat.moving",
    hints: { to: moving?.to._id ?? "s9" },
    resources: { names: { people: { collection: "profile" } } },
    viewer: { name: ME },
    call: () => Promise.resolve(),
    emit: () => Promise.resolve(),
    show: () => null,
    db: {
      collection: (name: string) => ({
        query: (query: string, params: { ids?: string[] }) => ({
          status: "ready",
          value: name === "thread" && query === "moving"
            ? moving
            : query === "names"
            ? Object.fromEntries((params.ids ?? []).map((id) => [id, id === "bo" ? "Bo" : id]))
            : undefined,
        }),
      }),
    },
  };
  return renderToStaticMarkup(<>{movingView({ _id: "c1" }, ctx as never)}</>)
    .replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'");
}

const place = (id: string, name: string, kind = "shared", owner?: string) => ({
  _id: id,
  name,
  kind,
  ...(owner ? { owner } : {}),
});

test("what moving a chat says: who'll see it there, and what it drew on", () => {
  assertEquals(
    said({
      to: launch,
      people: 12,
      drew: [place("s1", "Squad 1"), place("s3", "Finance")],
      elsewhere: 0,
    }),
    "Everyone in Launch (12 people) will see this whole conversation. It drew on Squad 1 and Finance.",
  );
  // Nothing drawn on: nothing more to say.
  assertEquals(
    said({ to: launch, people: 1, drew: [], elsewhere: 0 }),
    "Everyone in Launch (1 person) will see this whole conversation.",
  );
  // Into your own Personal space: only you.
  assertEquals(
    said({ to: place("p1", "Sam", "personal", ME), people: 1, drew: [], elsewhere: 0 }),
    "Only you will see this conversation, in your Personal space.",
  );
  assertEquals(
    said({
      to: place("p1", "Sam", "personal", ME),
      people: 1,
      drew: [place("s1", "Squad 1")],
      elsewhere: 0,
    }),
    "Only you will see this conversation, in your Personal space. It drew on Squad 1.",
  );
  // Personal spaces it drew on: yours, and someone else's by their name.
  assertEquals(
    said({
      to: launch,
      people: 4,
      drew: [place("p1", "Sam", "personal", ME), place("p2", "Bo", "personal", "bo")],
      elsewhere: 0,
    }),
    "Everyone in Launch (4 people) will see this whole conversation. It drew on your Personal space and Bo's Personal space.",
  );
  // Into someone else's.
  assertEquals(
    said({ to: place("p2", "Bo", "personal", "bo"), people: 1, drew: [], elsewhere: 0 }),
    "Bo will see this whole conversation, in their Personal space.",
  );
});

test("what moving says of spaces it drew on that the mover doesn't reach: one, or how many", () => {
  assertEquals(
    said({ to: launch, people: 3, drew: [place("s3", "Finance")], elsewhere: 1 }),
    "Everyone in Launch (3 people) will see this whole conversation. It drew on Finance and another space.",
  );
  assertEquals(
    said({ to: launch, people: 3, drew: [], elsewhere: 1 }),
    "Everyone in Launch (3 people) will see this whole conversation. It drew on another space.",
  );
  assertEquals(
    said({
      to: launch,
      people: 3,
      drew: [place("s1", "Squad 1"), place("s3", "Finance")],
      elsewhere: 2,
    }),
    "Everyone in Launch (3 people) will see this whole conversation. It drew on Squad 1, Finance and 2 other spaces.",
  );
  // A space whose people aren't counted, and one the mover doesn't reach: nothing said.
  assertEquals(
    said({ to: launch, people: 0, drew: [], elsewhere: 0 }),
    "Everyone in Launch will see this whole conversation.",
  );
  assertEquals(said(null), "");
});

/** A palette that notes what's pushed onto it, and going back. */
function palette() {
  const pushed: PaletteStep[] = [];
  let back = 0;
  const control: PaletteControl = {
    search: "",
    push: (step) => void pushed.push(step),
    back: () => void back++,
    close: () => {},
    pick: () => Promise.resolve(),
    dialog: () => {},
  };
  return { control, pushed, backs: () => back };
}

test("picking a space asks first, and moves only on its first choice", async () => {
  const calls: [string, unknown][] = [];
  const call = <R,>(action: string, input?: unknown) => {
    calls.push([action, input]);
    return Promise.resolve({} as R);
  };
  const step = moveStep({ thread: "c1", title: "Plan", from: "s1", call });
  assertEquals([step.title, step.view, step.hints], ["Move “Plan” to…", "space.pick", {
    from: "s1",
  }]);
  const at = palette();
  await step.pick!({ ...launch, can: ["write"] }, at.control);
  assertEquals(calls, [], "nothing moves on a pick");
  const asked = at.pushed[0];
  assertEquals([asked.title, asked.confirm], ["Move “Plan” to Launch?", true]);
  // Its note: who'll see it there, read by its own View once asked.
  const note = asked.note as ReactElement<{ kind: string; item: unknown; hints: unknown }>;
  assertEquals(note.type, LazyView);
  assertEquals([note.props.kind, note.props.item, note.props.hints], ["chat.moving", {
    _id: "c1",
  }, { to: "s2" }]);
  const [move, keep] = asked.items!("")[0].items;
  assertEquals([move.label, keep.label], ["Move to Launch", "Keep it where it is"]);

  await keep.run!(at.control);
  assertEquals([calls, at.backs()], [[], 1]);
  await move.run!(at.control);
  assertEquals(calls, [["chat.move", { thread: "c1", to: "s2" }]]);

  // Into a Personal space, it says so.
  const mine = palette();
  await step.pick!(place("p1", "Sam", "personal", ME), mine.control);
  assertEquals(mine.pushed[0].title, "Move “Plan” to Personal?");
  assert(mine.pushed[0].items!("")[0].items[0].label === "Move to Personal");
});
