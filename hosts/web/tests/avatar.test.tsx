/**
 * The avatar's picture: from the web, the app's own origin, or an image picked but not yet sent
 * (a `blob:` or a small image's `data:` URL), and nothing else; and an empty box instead of an
 * initial when asked.
 */
import { assert, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { Avatar } from "../toolkit/avatar.tsx";

const markup = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

test("pictures: https, own origin, blob and image data; no other scheme", () => {
  for (
    const ok of [
      "https://x.example/a.png",
      "/item_pics/3",
      "blob:https://app.example/1b2c-3d",
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQ",
      "data:image/webp,abc",
    ]
  ) assertStringIncludes(markup(<Avatar name="Ana" picture={ok} />), "<img");
  for (
    const bad of [
      "http://x.example/a.png",
      "//x.example/a.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:text/html;base64,PGI+",
      "file:///etc/passwd",
    ]
  ) assert(!markup(<Avatar name="Ana" picture={bad} />).includes("<img"), bad);
});

test("an initial by default; initial={false} draws an empty box until a picture is there", () => {
  assertStringIncludes(markup(<Avatar name="ana" />), ">A</span>");
  const empty = markup(<Avatar name="ana" initial={false} />);
  assertStringIncludes(empty, "copilotz-avatar-empty");
  assert(!empty.includes(">A<"));
  const pic = markup(<Avatar name="ana" initial={false} picture="blob:https://a.example/1" />);
  assert(!pic.includes("copilotz-avatar-empty"));
  assertStringIncludes(pic, "<img");
});
