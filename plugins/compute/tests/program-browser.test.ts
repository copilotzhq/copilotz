/**
 * The computer's browser on local pages: each who has a Chrome of its own in
 * a space (muted, hidden, on a profile of its own), which navigates, reads
 * and clicks; what a who keeps (cookies, the session's too, and storage)
 * outlasts its Chrome stopping, idle or with the program, and no other who
 * sees it; hidden, it doesn't say it's headless; a window is refused when its
 * person turned them off (or there's no display); a search turned away by
 * fetch goes through it; and nothing is left running once the computer stops.
 * Skipped without Chrome or Chromium on the machine. A shown window opens only
 * with COPILOTZ_TEST_HEADED=1.
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import process from "node:process";
import { env, serve, tempDir, test } from "../../../testing/mod.ts";
import {
  cannotShow,
  createBrowsers,
  findChrome,
  profileName,
  profilePath,
} from "../computers/program/browser/mod.ts";
import type { Result } from "../computers/program/browser/types.ts";
import { type Scope, type SearchResult, WORK } from "../computers/shared/workloads.ts";
import { PAGE, RESULTS, TURNED_AWAY } from "./program-pages.ts";
import { setup, until } from "./program-setup.ts";

const chrome = await findChrome();
const scope = (who: string): Scope => ({ space: "space-alpha", folder: "alpha", who });

/** Every running command line that names `text`. */
const running = (text: string) =>
  (process.platform === "win32"
    ? execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
    ], { encoding: "utf8" })
    : execFileSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8" }))
    .split(/\r?\n/).filter((line) => line.includes(text));

/** The Chrome on `profile` (its browser process, not its helpers). */
const chromeOn = (profile: string) =>
  running(`--user-data-dir=${profile} `).filter((line) => !line.includes("--type="));

/**
 * A site to sign in to: `/set` gives a cookie that lasts, and `/session` one
 * for the session only (each its own: the test server sends one set-cookie);
 * `/echo` shows the cookies it's sent; `/pop` opens a popup. It hears every
 * request's user agent.
 */
async function site() {
  const agents: { path: string; agent: string }[] = [];
  const server = await serve((request) => {
    const url = new URL(request.url);
    agents.push({ path: url.pathname, agent: request.headers.get("user-agent") ?? "" });
    const html = (body: string, headers: Record<string, string> = {}) =>
      new Response(body, { headers: { "content-type": "text/html", ...headers } });
    if (url.pathname === "/set") {
      return html("<title>Signed in</title>", { "set-cookie": "lasting=1; Max-Age=86400; Path=/" });
    }
    if (url.pathname === "/session") {
      return html("<title>Signed in</title>", { "set-cookie": "session=1; Path=/; HttpOnly" });
    }
    if (url.pathname === "/echo") {
      const cookies = (request.headers.get("cookie") ?? "").replace(/[<>&]/g, "");
      return html(`<title>Echo</title><p id="cookies">cookies: ${cookies}</p>`);
    }
    if (url.pathname === "/pop") {
      return html(
        `<title>Pop</title><a id="open" href="/popup" target="_blank">open</a>`,
      );
    }
    return html(PAGE);
  });
  return { server, agents, url: (path: string) => `${server.url}${path}` };
}

test({
  name: "a hidden browser per space and who: navigate, read, click, search, close",
  ignore: !chrome,
  fn: async () => {
    const methods: string[] = [];
    const server = await serve((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/html/") {
        methods.push(request.method);
        // The fetch is turned away; the browser's page load isn't.
        return request.method === "POST"
          ? new Response(TURNED_AWAY, { status: 202, headers: { "content-type": "text/html" } })
          : new Response(RESULTS, { headers: { "content-type": "text/html" } });
      }
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    });
    let browsers = "";
    try {
      await setup(async ({ work, root }) => {
        const real = realpathSync(root);
        browsers = join(real, ".copilotz", "browser");
        const browse = (who: string, actions: Record<string, unknown>[]) =>
          work<Result>(WORK.browser, { scope: scope(who), actions });
        const page = `${server.url}/`;

        const opened = await browse("agent:a", [{ action: "navigate", url: page }, {
          action: "read",
        }]);
        assert(opened.success, JSON.stringify(opened));
        assertEquals(opened.title, "Engine fixture");
        assertEquals(opened.window, "hidden");
        assertStringIncludes(String(opened.results[1].text), "stored: none");

        const clicked = await browse("agent:a", [{ action: "click", selector: "#click" }]);
        assert(clicked.success, JSON.stringify(clicked));
        assertStringIncludes(String(clicked.results[0].text), "Clicked 1");

        // By the refs of a snapshot: click, and type.
        const snapshot = await browse("agent:a", [{ action: "snapshot" }]);
        const refs = snapshot.results[0].refs as Record<string, { role: string; name: string }>;
        const ref = (role: string, name: RegExp) =>
          Object.entries(refs).find(([, value]) => value.role === role && name.test(value.name))
            ?.[0];
        const button = ref("button", /Clicked/);
        const field = ref("textbox", /Name/);
        assert(button && field, JSON.stringify(refs));
        const typed = await browse("agent:a", [
          { action: "click", ref: button },
          { action: "type", ref: field, text: "Ada" },
          {
            action: "evaluate",
            expression: "({clicks: window.clicks, name: document.querySelector('#name').value})",
          },
        ]);
        assert(typed.success, JSON.stringify(typed));
        assertEquals(typed.results[2].result, { clicks: 2, name: "Ada" });

        // What one who keeps, another doesn't see: a Chrome each.
        const stored = await browse("agent:a", [
          { action: "evaluate", expression: "localStorage.setItem('who', 'a')" },
          { action: "reload" },
        ]);
        assertStringIncludes(String(stored.results[1].text), "stored: a");
        const other = await browse("agent:b", [{ action: "navigate", url: page }, {
          action: "read",
        }]);
        assertStringIncludes(String(other.results[1].text), "stored: none");

        // A Chrome per who: hidden, muted, no debugging port, on who's own profile in the space.
        const profileA = profilePath(real, "alpha", "agent:a");
        const profileB = profilePath(real, "alpha", "agent:b");
        assertEquals(profileA, join(browsers, "alpha", profileName("agent:a")));
        assert(existsSync(join(profileA, "Default")), "Chrome keeps its profile there");
        for (const profile of [profileA, profileB]) {
          const lines = chromeOn(profile);
          assertEquals(lines.length, 1, `${profile}:\n${running("--user-data-dir").join("\n")}`);
          assertStringIncludes(lines[0], "--mute-audio");
          assertStringIncludes(lines[0], "--headless");
          assert(!lines[0].includes("--remote-debugging-port"), "no debugging port");
        }

        // Turned away by fetch, the search goes through the browser.
        const found = await work<SearchResult[]>(WORK.search, {
          scope: scope("agent:a"),
          query: "x",
        });
        assertEquals(found.map((r) => r.url), [
          "https://deno.com/",
          "https://nodejs.org/en/about?a=1&b=2",
          "https://bun.sh/",
        ]);
        assertEquals(methods, ["POST", "GET"]);

        // `close` stops who's Chrome; the other's stays.
        const closed = await browse("agent:b", [{ action: "close" }]);
        assertEquals(closed.results[0].closed, true);
        assertEquals(chromeOn(profileB), []);
        const still = await browse("agent:a", [{ action: "read" }]);
        assertStringIncludes(String(still.results[0].text), "stored: a");
      }, { chromium: chrome, searchUrl: `${server.url}/html/` });
      // Stopped: no Chrome is left on any profile.
      assertEquals(running(browsers), []);
    } finally {
      await server.close();
    }
  },
});

test({
  name: "who's sign-ins and storage outlast its Chrome stopping when idle; another who's are apart",
  ignore: !chrome,
  fn: async () => {
    const { server, url } = await site();
    let browsers = "";
    try {
      await setup(async ({ work, root }) => {
        browsers = join(realpathSync(root), ".copilotz", "browser");
        const profile = profilePath(realpathSync(root), "alpha", "agent:a");
        const browse = (who: string, actions: Record<string, unknown>[]) =>
          work<Result>(WORK.browser, { scope: scope(who), actions });
        const signedIn = await browse("agent:a", [
          { action: "navigate", url: url("/set") },
          { action: "navigate", url: url("/session") },
          {
            action: "evaluate",
            expression: "localStorage.setItem('kept', 'yes'); document.cookie = 'script=1; path=/'",
          },
        ]);
        assert(signedIn.success, JSON.stringify(signedIn));

        // Another who, on the same site: none of it.
        const other = await browse("agent:b", [
          { action: "navigate", url: url("/echo") },
          { action: "evaluate", expression: "localStorage.getItem('kept')" },
        ]);
        assert(other.success, JSON.stringify(other));
        assertEquals(String(other.results[0].title), "Echo");
        assertEquals(other.results[1].result, null);
        const otherText = await browse("agent:b", [{ action: "read", selector: "#cookies" }]);
        assertEquals(String(otherText.results[0].text).trim(), "cookies:");

        // Unused, who's Chrome stops; browsing again starts it on the same profile.
        await until(() => chromeOn(profile).length === 0, "a's Chrome stopped, idle", 15_000);
        const back = await browse("agent:a", [
          { action: "navigate", url: url("/echo") },
          { action: "read", selector: "#cookies" },
          { action: "evaluate", expression: "localStorage.getItem('kept')" },
        ]);
        assert(back.success, JSON.stringify(back));
        const cookies = String(back.results[1].text);
        for (const cookie of ["lasting=1", "session=1", "script=1"]) {
          assertStringIncludes(cookies, cookie);
        }
        assertEquals(back.results[2].result, "yes");
      }, { chromium: chrome, browserIdleMs: 400 });
      assertEquals(running(browsers), []);
    } finally {
      await server.close();
    }
  },
});

test({
  name: "who's sign-ins and storage outlast the program stopping and starting again",
  ignore: !chrome,
  fn: async () => {
    const { server, url } = await site();
    try {
      await setup(async ({ work, root, computer, start }) => {
        const profile = profilePath(realpathSync(root), "alpha", "agent:a");
        const browse = (actions: Record<string, unknown>[]) =>
          work<Result>(WORK.browser, { scope: scope("agent:a"), actions });
        const signedIn = await browse([
          { action: "navigate", url: url("/set") },
          { action: "navigate", url: url("/session") },
          { action: "evaluate", expression: "localStorage.setItem('kept', 'yes')" },
        ]);
        assert(signedIn.success, JSON.stringify(signedIn));
        assertEquals(
          chromeOn(profile).length,
          1,
          `${profile}:\n${running("--user-data-dir").join("\n")}`,
        );

        await computer.stop();
        assertEquals(chromeOn(profile), []);
        await (await start()).ready;
        const back = await browse([
          { action: "navigate", url: url("/echo") },
          { action: "read", selector: "#cookies" },
          { action: "evaluate", expression: "localStorage.getItem('kept')" },
        ]);
        assert(back.success, JSON.stringify(back));
        assertStringIncludes(String(back.results[1].text), "lasting=1");
        assertStringIncludes(String(back.results[1].text), "session=1");
        assertEquals(back.results[2].result, "yes");
      }, { chromium: chrome });
    } finally {
      await server.close();
    }
  },
});

test({
  name: "hidden, it doesn't say it's headless: in pages, requests, new tabs and popups",
  ignore: !chrome,
  fn: async () => {
    const { server, agents, url } = await site();
    try {
      await setup(async ({ work }) => {
        const browse = (actions: Record<string, unknown>[]) =>
          work<Result>(WORK.browser, { scope: scope("agent:a"), actions });
        const opened = await browse([
          { action: "navigate", url: url("/pop") },
          {
            action: "evaluate",
            expression:
              "({agent: navigator.userAgent, webdriver: navigator.webdriver, brands: navigator.userAgentData.brands.map(b => b.brand)})",
          },
          { action: "click", selector: "#open" },
          { action: "evaluate", expression: "navigator.userAgent" },
          { action: "tabs", operation: "new", url: url("/tab") },
          { action: "evaluate", expression: "navigator.userAgent" },
        ]);
        assert(opened.success, JSON.stringify(opened));
        const { agent, webdriver, brands } = opened.results[1].result as {
          agent: string;
          webdriver: boolean;
          brands: string[];
        };
        assert(/ Chrome\/\d/.test(agent) && !agent.includes("Headless"), agent);
        assertEquals(webdriver, false);
        assert(!brands.some((brand) => /headless/i.test(brand)), brands.join());
        // The popup (followed after the click) and the new tab say the same.
        assertEquals(opened.results[3].result, agent);
        assertEquals(opened.results[5].result, agent);
        for (const path of ["/pop", "/popup", "/tab"]) {
          const heard = agents.filter((a) => a.path === path);
          assert(heard.length, `${path} was asked for`);
          for (const a of heard) assertEquals(a.agent, agent, path);
        }
      }, { chromium: chrome });
    } finally {
      await server.close();
    }
  },
});

test({
  name: "a window is refused when its person turned them off; a request's window is checked",
  ignore: !chrome,
  fn: async () => {
    await setup(async ({ work, root }) => {
      const browsers = join(realpathSync(root), ".copilotz", "browser");
      const browse = (input: Record<string, unknown>) =>
        work<Result>(WORK.browser, { scope: scope("agent:a"), ...input });
      const shown = await browse({ actions: [{ action: "read" }], window: "shown" });
      assertEquals(shown.success, false);
      assertEquals(shown.window, "hidden");
      assertEquals(shown.results[0].code, "denied");
      assertStringIncludes(String(shown.results[0].error), "turned browser windows off");
      // Nothing started for it.
      assertEquals(running(browsers), []);

      const odd = await browse({ actions: [{ action: "read" }], window: "maximized" });
      assertEquals([odd.results[0].code, odd.window], ["invalid", "hidden"]);
      const extra = await browse({ actions: [{ action: "read" }], screen: 2 });
      assertEquals(extra.results[0].code, "invalid");

      // Hidden, it still browses.
      const hidden = await browse({ actions: [{ action: "read" }], window: "hidden" });
      assert(hidden.success, JSON.stringify(hidden));
      assertEquals(hidden.window, "hidden");
    }, { chromium: chrome, windows: "never" });
  },
});

test({
  name: "a profile another Chrome has is busy: the second isn't handed to the first",
  ignore: !chrome,
  fn: async () => {
    const root = realpathSync(tempDir());
    const workdir = join(root, "alpha");
    mkdirSync(workdir);
    const where = { folder: "alpha", workdir, who: "agent:a" };
    // Two programs on one root, say.
    const one = createBrowsers({ root, chromium: chrome });
    const two = createBrowsers({ root, chromium: chrome });
    try {
      const first = await one.run(where, { actions: [{ action: "read" }] });
      assert(first.success, JSON.stringify(first));
      const second = await two.run(where, { actions: [{ action: "read" }] });
      assertEquals([second.success, second.results[0].code], [false, "busy"]);
      assertStringIncludes(String(second.results[0].error), "has this browser's profile");
      assertEquals(chromeOn(profilePath(root, "alpha", "agent:a")).length, 1);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
    assertEquals(running(join(root, ".copilotz")), []);
  },
});

test("a window can't be shown when its person turned them off, or on Linux with no display", () => {
  assertEquals(cannotShow("never", { DISPLAY: ":0" }, "linux")?.code, "denied");
  assertEquals(cannotShow("never", {}, "darwin")?.code, "denied");
  const none = cannotShow("allow", {}, "linux");
  assertEquals(none?.code, "no_display");
  assertStringIncludes(String(none?.message), "DISPLAY");
  assertEquals(cannotShow(undefined, { DISPLAY: ":0" }, "linux"), undefined);
  assertEquals(cannotShow(undefined, { WAYLAND_DISPLAY: "wayland-0" }, "linux"), undefined);
  assertEquals(cannotShow("allow", {}, "darwin"), undefined);
});

test("who's profile is a plain folder name of its own", () => {
  const name = profileName("agent:assistant");
  assert(/^agent-assistant-[0-9a-f]{12}$/.test(name), name);
  assertEquals(profileName("agent:assistant"), name);
  // Apart even where file names ignore case, and whatever who is called.
  assertNotEquals(profileName("person:Ana"), profileName("person:ana"));
  assertNotEquals(profileName("agent:a/b"), profileName("agent:a-b"));
  for (const who of ["../../etc", ".hidden", "person:" + "x".repeat(500), "::", "pessoa:joão"]) {
    const plain = profileName(who);
    assert(/^[a-z0-9][a-z0-9-]*$/.test(plain) && plain.length <= 64, plain);
  }
  assertEquals(
    profilePath("/root", "alpha", "agent:assistant"),
    join("/root", ".copilotz", "browser", "alpha", name),
  );
});

test({
  name: "shown on the person's screen and hidden again: the same profile, the same page",
  ignore: !chrome || env("COPILOTZ_TEST_HEADED") !== "1",
  fn: async () => {
    const { server, url } = await site();
    let browsers = "";
    try {
      await setup(async ({ work, root }) => {
        browsers = join(realpathSync(root), ".copilotz", "browser");
        const profile = profilePath(realpathSync(root), "alpha", "agent:a");
        const browse = (actions: Record<string, unknown>[], window?: string) =>
          work<Result>(WORK.browser, { scope: scope("agent:a"), actions, window });
        const state = [
          { action: "read", selector: "#cookies" },
          { action: "evaluate", expression: "[localStorage.getItem('kept'), navigator.userAgent]" },
        ];
        const hidden = await browse([
          { action: "navigate", url: url("/set") },
          { action: "navigate", url: url("/session") },
          { action: "evaluate", expression: "localStorage.setItem('kept', 'yes')" },
          { action: "navigate", url: url("/echo") },
        ]);
        assert(hidden.success, JSON.stringify(hidden));
        assertEquals(hidden.window, "hidden");
        assertStringIncludes(chromeOn(profile)[0], "--headless");

        const shown = await browse(state, "shown");
        assert(shown.success, JSON.stringify(shown));
        assertEquals([shown.window, shown.currentUrl], ["shown", url("/echo")]);
        const [line] = chromeOn(profile);
        assert(!line.includes("--headless"), line);
        assertStringIncludes(line, "--mute-audio");
        assertStringIncludes(line, "--window-name=Copilotz");
        assertStringIncludes(String(shown.results[0].text), "lasting=1");
        assertStringIncludes(String(shown.results[0].text), "session=1");
        const [kept, agent] = shown.results[1].result as string[];
        assertEquals(kept, "yes");
        assert(!agent.includes("Headless"), agent);

        // Unless asked otherwise, it stays shown.
        const still = await browse([{ action: "reload" }]);
        assertEquals(still.window, "shown");

        const again = await browse(state, "hidden");
        assert(again.success, JSON.stringify(again));
        assertEquals([again.window, again.currentUrl], ["hidden", url("/echo")]);
        assertStringIncludes(chromeOn(profile)[0], "--headless");
        assertStringIncludes(String(again.results[0].text), "session=1");
        assertEquals((again.results[1].result as string[])[0], "yes");
      }, { chromium: chrome });
      assertEquals(running(browsers), []);
    } finally {
      await server.close();
    }
  },
});
