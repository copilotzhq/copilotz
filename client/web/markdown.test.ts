import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownUrlPolicy } from "./index.ts";

const page = markdownUrlPolicy({
  origin: "https://app.example",
  imageOrigins: [
    "https://cdn.example/ignored/path",
    "not an origin",
    "ftp://x",
  ],
});

test("images load only from relative, same-origin or allowlisted origins", () => {
  for (
    const url of [
      "/files/a.png",
      "b.png",
      "./c.png?size=2#top",
      "https://app.example/files/a.png",
      "https://cdn.example/a.png",
    ]
  ) {
    assert.equal(page.loadsImage(url), true, url);
    assert.equal(page.urlTransform(url, "src"), url, url);
  }
  for (
    const url of [
      "https://evil.example/collect?q=secret",
      "http://app.example/insecure-is-another-origin.png",
      "//evil.example/pixel.png",
      "\\\\evil.example\\pixel.png",
      "https://cdn.example.evil.example/a.png",
      "https://app.example.evil.example/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "blob:https://app.example/1",
      "ftp://x/a.png",
      "",
    ]
  ) {
    assert.equal(page.loadsImage(url), false, url);
    // Any non-link attribute fetches without a click, so it follows images.
    for (const key of ["src", "poster", "srcSet"]) {
      assert.equal(page.urlTransform(url, key), "", `${key} ${url}`);
    }
  }
});

test("without a page origin only relative images load", () => {
  const host = markdownUrlPolicy({ origin: "null" });
  assert.equal(host.loadsImage("/a.png"), true);
  assert.equal(host.loadsImage("https://app.example/a.png"), false);
  assert.equal(host.loadsImage("//app.example/a.png"), false);
  assert.equal(
    markdownUrlPolicy({ imageOrigins: ["https://cdn.example"] })
      .loadsImage("https://cdn.example/a.png"),
    true,
  );
});

test("links keep relative and safe protocols and drop script URLs", () => {
  for (
    const url of [
      "https://example.com/a",
      "http://example.com",
      "mailto:someone@example.com",
      "/relative/path:with-colon",
      "?tab=a:b",
      "#section:1",
      "https://evil.example/any-remote-link-is-click-only",
    ]
  ) assert.equal(page.urlTransform(url, "href"), url, url);
  for (
    const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\nscript:alert(1)",
      "vbscript:msgbox",
      "data:text/html,<script>alert(1)</script>",
    ]
  ) assert.equal(page.urlTransform(url, "href"), "", url);
  assert.deepEqual(page.linkAttributes, {
    target: "_blank",
    rel: "noopener noreferrer nofollow",
  });
  assert.ok(Object.isFrozen(page.linkAttributes));
});
