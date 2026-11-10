/**
 * Home greets the person by the name the page knows them by now (`ctx.viewer.label`, which the
 * host keeps as their record says); with none, plainly: never by their id.
 */
import { assertFalse, assertMatch } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import type { Viewer } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import { homeView } from "../chat/views/web/home.tsx";

/** A person's id as an app may make them: it says nothing, and never shows. */
const ID = "01JD3XQ7Z8K2M4N6P8R0S2T4V6";

/** Home's greeting, for this viewer. */
const greeting = (viewer: Viewer) => {
  const markup = renderToStaticMarkup(
    <>
      {homeView(
        {},
        {
          hints: {},
          resources: {},
          viewer,
          name: "home",
          call: () => Promise.resolve({} as never),
          emit: () => Promise.resolve(),
          show: () => null,
          db: {
            collection: () => ({
              query: () => ({ status: "ready", value: undefined }),
              find: () => ({ status: "ready", value: [] }),
              findOne: () => ({ status: "ready", value: undefined }),
            }),
          },
        } as never,
      )}
    </>,
  );
  return markup.match(/<h1 id="chat-home-title">([^<]*)<\/h1>/)?.[1] ?? "";
};

test("home greets the person by their name; with none, plainly, never by their id", () => {
  assertMatch(greeting({ kind: "person", name: ID, label: "Ana Lima" }), /^Good \w+, Ana$/);
  const plain = greeting({ kind: "person", name: ID, email: "ana@example.com" });
  assertMatch(plain, /^Good \w+$/);
  assertFalse(plain.includes(ID));
});
