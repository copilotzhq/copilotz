/**
 * Screenshots of the demo in headless Chrome over CDP, at desktop and phone
 * sizes, in light and dark. A temporary profile is created and deleted; only
 * localhost requests are allowed.
 *
 *   deno run -A contracts/web-demo/build.ts
 *   deno run -A contracts/web-demo/capture.ts <out-dir> [--only=name]
 * @module
 */
const here = new URL("./", import.meta.url);
const dist = new URL("dist/", here);
const out = Deno.args.find((arg) => !arg.startsWith("--")) ??
  new URL("screens/", here).pathname;
const only = Deno.args.find((arg) => arg.startsWith("--only="))?.slice(7);
/** Evaluate an expression in each scenario and log it (for debugging). */
const probe = Deno.args.find((arg) => arg.startsWith("--probe="))?.slice(8);
const CHROME = Deno.env.get("CHROME") ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const types: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
};
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  async (request) => {
    const path = new URL(request.url).pathname.replace(/^\/+/, "") ||
      "index.html";
    try {
      const body = await Deno.readFile(new URL(path, dist));
      return new Response(body, {
        headers: {
          "content-type": types[path.split(".").pop()!] ??
            "application/octet-stream",
        },
      });
    } catch {
      return new Response(await Deno.readFile(new URL("index.html", dist)), {
        headers: { "content-type": "text/html" },
      });
    }
  },
);
const origin = `http://127.0.0.1:${server.addr.port}`;

const profile = await Deno.makeTempDir({ prefix: "copilotz-chatui-" });
const debugPort = 9400 + Math.floor(Math.random() * 400);
const chrome = new Deno.Command(CHROME, {
  args: [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    "about:blank",
  ],
  stdout: "null",
  stderr: "null",
}).spawn();

let socketUrl: string | undefined;
for (let i = 0; i < 100 && !socketUrl; i++) {
  try {
    socketUrl =
      (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json())
        .webSocketDebuggerUrl;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
if (!socketUrl) throw new Error("Chrome did not start");
const ws = new WebSocket(socketUrl);
await new Promise((resolve) =>
  ws.addEventListener("open", resolve, { once: true })
);
let next = 1;
// deno-lint-ignore no-explicit-any -- CDP results are untyped JSON.
type Json = any;
const pending = new Map<
  number,
  { resolve(value: Json): void; reject(error: Error): void }
>();
const log: string[] = [];
let session = "";
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }
  const params = message.params ?? {};
  if (message.method === "Runtime.exceptionThrown") {
    log.push(
      `EXCEPTION ${
        params.exceptionDetails?.exception?.description ??
          params.exceptionDetails?.text
      }`,
    );
  } else if (
    message.method === "Runtime.consoleAPICalled" &&
    ["error", "warning"].includes(params.type)
  ) {
    log.push(
      `console.${params.type}: ${
        (params.args ?? []).map((arg: Json) => arg.value ?? arg.description)
          .join(" ").slice(0, 800)
      }`,
    );
  } else if (message.method === "Fetch.requestPaused") {
    const local = new URL(params.request.url).hostname === "127.0.0.1" ||
      params.request.url.startsWith("data:") ||
      params.request.url.startsWith("blob:");
    if (!local) log.push(`BLOCKED ${params.request.url}`);
    void send(local ? "Fetch.continueRequest" : "Fetch.failRequest", {
      requestId: params.requestId,
      ...(local ? {} : { errorReason: "BlockedByClient" }),
    }, session);
  }
});
function send(
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Promise<Json> {
  const id = next++;
  ws.send(
    JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
  );
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
session =
  (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
for (const domain of ["Runtime", "Page"]) {
  await send(`${domain}.enable`, {}, session);
}
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, session);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression: string): Promise<unknown> {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, session);
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result?.value;
}
async function navigate(path: string) {
  await send("Page.navigate", { url: origin + path }, session);
  for (let i = 0; i < 60; i++) {
    if (await evaluate("document.readyState").catch(() => "") === "complete") {
      break;
    }
    await wait(100);
  }
}
async function click(selector: string, index = 0) {
  const point = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${
    JSON.stringify(selector)
  })][${index}];
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`) as { x: number; y: number } | null;
  if (!point) throw new Error(`No element ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    }, session);
  }
  await wait(250);
}
async function key(keyName: string, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: keyName,
      code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
      windowsVirtualKeyCode: keyName === "Enter"
        ? 13
        : keyName.length === 1
        ? keyName.toUpperCase().charCodeAt(0)
        : 0,
      modifiers,
    }, session);
  }
  await wait(250);
}

type Size = { name: string; width: number; height: number; mobile: boolean };
const sizes: Size[] = [
  { name: "1440x900", width: 1440, height: 900, mobile: false },
  { name: "390x844", width: 390, height: 844, mobile: true },
];
type Scenario = {
  name: string;
  path: string;
  /** Runs after load; may click, type, or set preferences. */
  steps?: (size: Size) => Promise<void>;
  settle?: number;
};
const scenarios: Scenario[] = [
  { name: "01-chat-streaming", path: "/?chat=t-plan&freeze=1", settle: 2400 },
  {
    name: "02-chat-with-panel",
    path: "/?chat=t-plan&panel=1&section=overview&freeze=1",
    settle: 2400,
  },
  {
    name: "03-panel-boards-dot",
    path: "/?chat=t-plan&panel=1&section=boards&freeze=1",
    settle: 2400,
  },
  {
    name: "04-space-chats",
    path: "/?space=sp-launch&section=conversations&stream=0",
  },
  {
    name: "05-space-members",
    path: "/?space=sp-launch&section=members&stream=0",
  },
  {
    name: "06-sidebar-recent",
    path: "/?chat=t-ideas&stream=0",
    steps: async (size) => {
      if (size.mobile) await click('[aria-label="Expand sidebar"]');
      await click('[aria-pressed="false"]');
    },
  },
  { name: "07-new-chat", path: "/?stream=0" },
  {
    name: "08-activity-expanded",
    path: "/?chat=t-plan&stream=0",
    steps: async () => {
      await evaluate(
        `[...document.querySelectorAll('[data-slot="assistant-activity"] button[aria-expanded]')].forEach((b) => b.click())`,
      );
      await wait(300);
      await evaluate(
        `document.querySelector('[data-slot="assistant-activity"]')?.scrollIntoView({ block: "start" })`,
      );
    },
  },
  {
    name: "09-composer-attachments",
    path: "/?chat=t-ideas&stream=0",
    steps: async () => {
      await evaluate(`(() => {
        const input = document.querySelector('input[type="file"]');
        const data = new DataTransfer();
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" rx="8" fill="#6366f1"/><circle cx="40" cy="40" r="18" fill="#c7d2fe"/></svg>';
        data.items.add(new File([svg], "sketch.svg", { type: "image/svg+xml" }));
        data.items.add(new File([new Uint8Array(182000)], "survey-results.csv", { type: "text/csv" }));
        input.files = data.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const field = document.querySelector('textarea[aria-label="Message"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(field, "Here are the survey results and a sketch of the flow. @West can you check the sample size?");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
    },
  },
  {
    name: "10-command-palette",
    path: "/?chat=t-plan&stream=0",
    steps: async () => {
      await key("k", 4);
      await wait(200);
      await send("Input.insertText", { text: "la" }, session);
    },
  },
  {
    name: "11-thread-menu",
    path: "/?chat=t-plan&stream=0",
    steps: async (size) => {
      if (size.mobile) await click('[aria-label="Expand sidebar"]');
      await click('[aria-label="Options for Launch plan kickoff"]');
    },
  },
  {
    name: "12-panel-resized",
    path: "/?chat=t-plan&panel=1&section=documents&stream=0",
    steps: async (size) => {
      const handle = await evaluate(
        `(() => { const r = document.querySelector('[role="separator"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      ) as { x: number; y: number };
      const target = size.mobile ? handle.x + 40 : handle.x - 160;
      await send(
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", ...handle },
        session,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...handle,
        button: "left",
        clickCount: 1,
      }, session);
      for (
        let x = handle.x;
        size.mobile ? x < target : x > target;
        x += size.mobile ? 8 : -8
      ) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y: handle.y,
          button: "left",
        }, session);
      }
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: target,
        y: handle.y,
        button: "left",
        clickCount: 1,
      }, session);
      await wait(200);
      // The width is a preference: it survives a reload.
      await navigate("/?chat=t-plan&panel=1&section=documents&stream=0");
      await wait(900);
    },
  },
  {
    name: "13-sidebar-overlay",
    path: "/?chat=t-plan&stream=0",
    steps: async (size) => {
      if (size.mobile) await click('[aria-label="Expand sidebar"]');
      else await click('[aria-label="Collapse sidebar"]');
    },
  },
  {
    name: "14-send-and-stream",
    path: "/?chat=t-ideas&stream=0",
    steps: async () => {
      await click('textarea[aria-label="Message"]');
      await send("Input.insertText", {
        text: "Draft a two-line welcome email for new teams.",
      }, session);
      await key("Enter");
      await wait(1800);
    },
  },
];

await Deno.mkdir(out, { recursive: true });
const shots: string[] = [];
for (const size of sizes) {
  await Deno.mkdir(`${out}/${size.name}`, { recursive: true });
  await send("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: size.mobile ? 2 : 1,
    mobile: size.mobile,
  }, session);
  await send(
    "Emulation.setTouchEmulationEnabled",
    { enabled: size.mobile },
    session,
  );
  for (const theme of ["light", "dark"]) {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    }, session);
    for (const scenario of scenarios) {
      if (only && !scenario.name.includes(only)) continue;
      await navigate("/?stream=0");
      await evaluate("localStorage.clear()");
      await navigate(scenario.path);
      await wait(scenario.settle ?? 900);
      try {
        await scenario.steps?.(size);
      } catch (error) {
        log.push(`STEP ${scenario.name} ${size.name}: ${error}`);
      }
      await wait(500);
      if (probe) {
        log.push(
          `PROBE ${scenario.name} ${size.name} ${theme}: ${
            JSON.stringify(
              await evaluate(probe).catch((error) => String(error)),
            )
          }`,
        );
      }
      const { data } = await send(
        "Page.captureScreenshot",
        { format: "png" },
        session,
      );
      const file = `${out}/${size.name}/${scenario.name}-${theme}.png`;
      await Deno.writeFile(
        file,
        Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
      );
      shots.push(file);
    }
  }
}
await Deno.writeTextFile(
  `${out}/capture.log`,
  [...log, `${shots.length} screenshots`].join("\n") + "\n",
);
console.log(`${shots.length} screenshots, ${log.length} log lines → ${out}`);
ws.close();
chrome.kill();
await chrome.status;
await server.shutdown();
await Deno.remove(profile, { recursive: true }).catch(() => {});
