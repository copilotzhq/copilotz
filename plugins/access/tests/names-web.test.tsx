/**
 * A space's people on the web, by name (as React draws them): the Members
 * tab and the header list each person by their profile's name, never by a
 * sign-in's id; someone without a profile is "someone".
 */
import { assert, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Member, Reached } from "../spaces/contract.ts";
import { membersView } from "../spaces/views/web/members.tsx";
import { SpaceHeader } from "../spaces/views/web/header.tsx";
import { test } from "../../../testing/mod.ts";

const ANA = "google:113900649446232449762";
const BOB = "github:7";

/** A View's context over fixed reads: queries by `<collection>.<query>`, finds by collection. */
const ctxOf = (reads: Record<string, unknown>): ViewContext<ReactNode> => ({
  db: {
    collection: (name: string) => ({
      query: (query: string) => ({ status: "ready", value: reads[`${name}.${query}`] }),
      find: () => ({ status: "ready", value: (reads[name] ?? []) as never }),
    }),
  } as unknown as ViewContext<ReactNode>["db"],
  resources: { names: { collection: "profile" } },
  renderer: "web",
  kind: "test",
  viewer: { name: ANA },
  hints: {},
  show: () => null,
  call: () => Promise.resolve({} as never),
  emit: () => Promise.resolve(),
});

const text = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const space: Reached = {
  _id: "launch",
  name: "Launch",
  kind: "shared",
  at: "2026-10-30T09:00:00.000Z",
  can: ["read", "write", "manage"],
} as Reached;
const members: Member[] = [
  { _id: `launch|person:${ANA}`, space: "launch", member: `person:${ANA}`, role: "manager" },
  { _id: `launch|person:${BOB}`, space: "launch", member: `person:${BOB}`, role: "editor" },
] as Member[];

test("the Members tab lists people by name, never by a sign-in's id", () => {
  const shown = text(membersView(
    { _id: "launch" },
    ctxOf({
      "space.reached": [space],
      member: members,
      "profile.names": { [ANA]: "Ana Lima" },
    }),
  ));
  assertStringIncludes(shown, "Ana Lima You");
  // Bob has no profile yet: "someone", not his id.
  assertStringIncludes(shown, "someone");
  assert(!shown.includes(ANA) && !shown.includes(BOB), shown);
});

test("a space's header shows its people by name", () => {
  const html = renderToStaticMarkup(
    <SpaceHeader
      space={space}
      members={members}
      manage
      me={ANA}
      call={() => Promise.resolve({} as never)}
      names={{ [ANA]: "Ana Lima", [BOB]: "Bob Silva" }}
    >
      {null}
    </SpaceHeader>,
  );
  assertStringIncludes(html, "Members: Ana Lima, Bob Silva");
  assert(!html.includes(ANA), html);
});
