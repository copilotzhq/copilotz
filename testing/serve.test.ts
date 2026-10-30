/** The tests' own HTTP server answers as a handler does: every header, every cookie it sets. */
import { assertEquals } from "@std/assert";
import { serve, test } from "./mod.ts";

test("a test server sends every cookie a handler sets", async () => {
  const server = await serve(() => {
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Max-Age=60");
    return new Response("ok", { headers });
  });
  try {
    const response = await fetch(server.url);
    assertEquals(await response.text(), "ok");
    assertEquals(response.headers.get("content-type"), "text/plain");
    assertEquals(response.headers.getSetCookie(), ["a=1; Path=/", "b=2; Max-Age=60"]);
  } finally {
    await server.close();
  }
});
