/**
 * The widget host, in the browser: an app's web Views drawn inside an outside assistant's
 * conversation (an MCP Apps host: ChatGPT, Claude…), as the web host draws them on the app's own
 * page. The server's half is widgets.ts (the template this runs in, and snapshots); the MCP
 * interface's lines say which tool's calls are shown through which View
 * (`plugins/interfaces/mcp`).
 *
 * - **The bridge** is MCP Apps' (postMessage JSON-RPC with the host: `ui/initialize`, its host
 *   context, `ui/notifications/tool-result`, `host-context-changed`, `tools/call`,
 *   `ui/request-display-mode`, `ui/message`, `ui/update-model-context`, `ui/open-link`), and
 *   ChatGPT's `window.openai` where the host answers that instead (`toolResponseMetadata`,
 *   `callTool`, `requestDisplayMode`, `sendFollowUpMessage`, `openExternal`, `openai:set_globals`).
 * - **What it draws** comes in the tool result's `_meta` (the host's, never the model's):
 *   `copilotz/widget`, the View, its item and hints, who looks, what the View reads (answered on
 *   the server: the first paint asks nothing), the widget's grant, and which tools stand for
 *   which Actions. It observes the View with hints `{ …, mode, surface: "widget" }`, `mode` the
 *   host's display mode (`inline`, `pip`, `fullscreen`): a change observes it again.
 * - **Reads it hadn't** go in one call of the line's read tool (`copilotz_read`) per pass,
 *   with the grant. **Handlers' calls** (`ctx.call(action, input)`) go as the line's tool for
 *   that Action, with the grant and the reads watched, whose new answers come back with it: the
 *   widget redraws in that one round trip. An Action the line doesn't offer is refused here.
 * - **Nothing is pushed** to a widget: it asks its reads again when it's shown again, and while
 *   a View asks (`useRefresh`, a payment's status).
 * - **Its look** is the app's theme (the template carries its variables and fonts), dark or
 *   light as the host says (`data-theme`), its height told to the host as it changes.
 * - **What Views ask of it** (`display`, `tell`, `remind`, `openLink`: surface.ts) goes to the
 *   host; links to the web open the host's way.
 *
 * ```ts
 * // widgets.tsx, bundled with { split: false } for `widgetsOf({ code, plugins })`
 * await widget({ plugins: [brandTheme, bookingWeb], root: document.getElementById("app")! });
 * ```
 */
import { type ReactNode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Answer, Remote } from "../../runtime/browsers.ts";
import { type Client, connect, type Known } from "../../runtime/client.ts";
import type { Observation, Plugins, Viewer } from "../../runtime/mod.ts";
import { Part } from "./part.tsx";
import { session } from "./session.ts";
import { BASE } from "./style.ts";
import { say } from "./host-words.ts";
import { type DisplayMode, openLink, setSurface } from "./surface.ts";
import { ThemeContext } from "./theme/context.ts";
import { themeCss, themeOf } from "./theme/css.ts";

export type WidgetOptions = {
  plugins: Plugins;
  root: Element;
  /** How long it waits for its tool's result before saying there's nothing to show (15 s). */
  wait?: number;
};

/** What a tool result carries for its widget (see plugins/interfaces/mcp/resources/widgets.ts). */
export type WidgetMeta = {
  view: string;
  item: unknown;
  hints: Record<string, unknown>;
  viewer: Viewer;
  reads: Known;
  grant: string;
  /** The line's tool for each Action the widget may call. */
  tools: Record<string, string>;
  /** The line's read tool. */
  read: string;
};

type Json = Record<string, unknown>;
type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean; _meta?: Json };

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A result's `_meta`, wherever its host put it: on the result, or (ChatGPT) on the MCP result
 * it wraps (`call_tool_result`, `mcp_tool_result`).
 */
export function metaOf(result: unknown): Json {
  if (!isObject(result)) return {};
  const own = isObject(result._meta) ? result._meta : isObject(result.meta) ? result.meta : {};
  const wrapped = [
    result.call_tool_result,
    result.mcp_tool_result,
    own.call_tool_result,
    own.mcp_tool_result,
  ].find(isObject);
  const inner = wrapped && isObject(wrapped._meta) ? wrapped._meta : {};
  return { ...inner, ...own };
}

/** The widget's part of a result, when it has one. */
export function widgetOf(result: unknown): WidgetMeta | undefined {
  const meta = metaOf(result);
  const found = (isObject(result) && result["copilotz/widget"]) ?? meta["copilotz/widget"];
  if (!isObject(found) || typeof found.view !== "string" || typeof found.grant !== "string") {
    return undefined;
  }
  return found as unknown as WidgetMeta;
}

const textOf = (result: ToolResult) =>
  (result.content ?? []).map((c) => c.text ?? "").join("\n").trim();

/** ChatGPT's own API, where the host has it. */
type OpenAi = {
  toolResponseMetadata?: unknown;
  theme?: string;
  displayMode?: string;
  maxHeight?: number;
  callTool?(name: string, args: Json): Promise<unknown>;
  requestDisplayMode?(request: { mode: string }): Promise<unknown>;
  sendFollowUpMessage?(message: { prompt: string; scrollToBottom?: boolean }): Promise<void>;
  updateModelContext?(context: unknown): Promise<void>;
  setWidgetState?(state: unknown): void;
  openExternal?(target: { href: string }): void;
  notifyIntrinsicHeight?(height: number): void;
};
const openai = (): OpenAi | undefined => (globalThis as { openai?: OpenAi }).openai;

/** The MCP Apps bridge: JSON-RPC over postMessage with the host (the parent frame). */
function bridgeOf() {
  let next = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  const listeners = new Set<(method: string, params: Json) => void>();
  // The host's origin, once its first answer says it: from then on, only it is written to, and
  // only it is heard (until then the host is unknown: a sandbox's origin is the host's to choose).
  let origin = "*";
  const top = globalThis as unknown as { parent?: unknown };
  const inFrame = top.parent !== undefined && top.parent !== globalThis;
  addEventListener("message", (event: MessageEvent) => {
    if (event.source !== globalThis.parent) return;
    if (origin !== "*" && event.origin !== origin) return;
    const message = event.data as Json;
    if (!isObject(message) || message.jsonrpc !== "2.0") return;
    if (typeof message.id === "number" && !("method" in message)) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (origin === "*" && event.origin && event.origin !== "null") origin = event.origin;
      if (message.error) waiting.reject(message.error);
      else waiting.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    // The host asks before it takes the widget down: it's told yes.
    if (message.method === "ui/resource-teardown" && "id" in message) {
      globalThis.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, origin);
    }
    for (const listen of listeners) {
      listen(message.method, isObject(message.params) ? message.params : {});
    }
  });
  return {
    inFrame,
    request: (method: string, params: Json, timeout = 30_000) =>
      new Promise<unknown>((resolve, reject) => {
        if (!inFrame) return reject(new Error(say("noHost")));
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error(say("hostSilent")), { code: "unavailable" }));
        }, timeout);
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        globalThis.parent.postMessage({ jsonrpc: "2.0", id, method, params }, origin);
      }),
    notify: (method: string, params: Json) => {
      if (inFrame) globalThis.parent.postMessage({ jsonrpc: "2.0", method, params }, origin);
    },
    listen: (fn: (method: string, params: Json) => void) => listeners.add(fn),
  };
}

/** Once the template's own look is replaced by the host's, its copy goes. */
function Painted(): null {
  useLayoutEffect(() => document.getElementById("copilotz-first-paint")?.remove(), []);
  return null;
}

export async function widget(options: WidgetOptions): Promise<Client | undefined> {
  const react = createRoot(options.root);
  const theme = themeOf(options.plugins);
  const css = themeCss(theme);
  const draw = (node: ReactNode) =>
    react.render(
      <ThemeContext value={theme}>
        <style href="copilotz-theme" precedence="copilotz">{css}</style>
        <style href="copilotz-base" precedence="copilotz">{BASE}</style>
        <style href="copilotz-widget" precedence="copilotz">{WIDGET_CSS}</style>
        <Painted />
        {node}
      </ThemeContext>,
    );
  draw(null);

  const bridge = bridgeOf();
  let mode: DisplayMode = "inline";
  const setTheme = (said: unknown) => {
    if (said === "dark" || said === "light") document.documentElement.dataset.theme = said;
  };
  const setMode = (said: unknown) =>
    said === "inline" || said === "pip" || said === "fullscreen" ? said : undefined;

  // What the tool's result said, from the bridge's notification or ChatGPT's globals.
  let found: WidgetMeta | undefined;
  const arrived = Promise.withResolvers<WidgetMeta | undefined>();
  const take = (result: unknown) => {
    const meta = widgetOf(result);
    if (meta && !found) {
      found = meta;
      arrived.resolve(meta);
    }
  };
  // Set once the View is shown: what a change of the host's context does.
  const context: { changed?: (said: Json) => void } = {};
  bridge.listen((method, params) => {
    if (method === "ui/notifications/tool-result") take(params);
    if (method === "ui/notifications/host-context-changed") context.changed?.(params);
  });

  // MCP Apps' handshake; a host that doesn't answer it is ChatGPT's own API alone.
  let standard = false;
  try {
    const answer = await bridge.request("ui/initialize", {
      protocolVersion: "2026-01-26",
      clientInfo: { name: "copilotz-widget", version: "1" },
      appInfo: { name: "copilotz-widget", version: "1" },
      capabilities: {},
      appCapabilities: { availableDisplayModes: ["inline", "pip", "fullscreen"] },
    }, 1_500) as Json;
    standard = true;
    const context = isObject(answer?.hostContext) ? answer.hostContext : {};
    setTheme(context.theme);
    mode = setMode(context.displayMode) ?? mode;
    bridge.notify("ui/notifications/initialized", {});
  } catch {
    // ChatGPT's API, where it's all there is.
  }
  const globals = () => {
    const api = openai();
    if (!api) return;
    setTheme(api.theme);
    take(api.toolResponseMetadata);
    return api;
  };
  globals();
  addEventListener("openai:set_globals", () => {
    const before = mode;
    const api = globals();
    const now = setMode(api?.displayMode);
    if (now && now !== before) context.changed?.({ displayMode: now });
  });
  if (!standard) mode = setMode(openai()?.displayMode) ?? mode;
  // ChatGPT may set its globals after the page loads: look again a while.
  const looking = setInterval(globals, 200);
  const timer = setTimeout(() => arrived.resolve(undefined), options.wait ?? 15_000);
  const meta = await arrived.promise;
  clearInterval(looking);
  clearTimeout(timer);
  if (!meta) {
    draw(<div className="copilotz-widget-empty" role="status" />);
    return undefined;
  }

  /** A tool call through the host: MCP Apps' `tools/call`, else ChatGPT's `callTool`. */
  const callTool = async (name: string, args: Json): Promise<ToolResult> => {
    if (standard) {
      try {
        return await bridge.request("tools/call", { name, arguments: args }) as ToolResult;
      } catch (error) {
        const said = String((error as { message?: unknown })?.message ?? "");
        const code = (error as { code?: unknown })?.code;
        if (
          !openai()?.callTool ||
          !(code === -32601 || /not found|unsupported|not supported/i.test(said))
        ) {
          throw error;
        }
      }
    }
    const api = openai();
    if (!api?.callTool) {
      throw Object.assign(new Error(say("widgetCantCall")), {
        code: "unavailable",
      });
    }
    return await api.callTool(name, args) as ToolResult;
  };

  // Each reply brings a new grant (one in use never runs out; one that leaked does).
  const renew = (result: ToolResult) => {
    const grant = metaOf(result)["copilotz/grant"];
    if (typeof grant === "string") meta.grant = grant;
  };
  const answersOf = (result: ToolResult): Known => {
    const reads = metaOf(result)["copilotz/reads"];
    return Array.isArray(reads) ? reads as Known : [];
  };
  const client: Client = connect({
    plugins: options.plugins,
    known: meta.reads ?? [],
    link: {
      read: async (reads: { key: string; read: Remote }[]) => {
        const result = await callTool(meta.read, { reads, _grant: meta.grant });
        renew(result);
        const answers = new Map(answersOf(result));
        const failed: Answer = {
          error: { message: textOf(result) || say("couldntRead"), code: "unavailable" },
        };
        return reads.map(({ key }) => ({ key, ...(answers.get(key) ?? failed) }));
      },
      call: async (action: string, input: unknown) => {
        const tool = meta.tools?.[action];
        if (!tool) {
          throw Object.assign(new Error(say("notOffered", { action })), {
            code: "forbidden",
          });
        }
        const result = await callTool(tool, {
          ...(isObject(input) ? input : {}),
          _grant: meta.grant,
          // Its own id: the line runs a call once by it (a host may number requests again).
          _call: crypto.randomUUID(),
          _reads: client.watching(),
        });
        renew(result);
        const answers = answersOf(result);
        if (answers.length) client.update(answers);
        const said = metaOf(result);
        if (result.isError) {
          const error = isObject(said["copilotz/error"]) ? said["copilotz/error"] : {};
          throw Object.assign(new Error(String(error.message ?? textOf(result))), error);
        }
        return said["copilotz/result"];
      },
    },
  });
  session.client = client;
  session.viewer = meta.viewer;

  // What Views ask of their host (surface.ts).
  const intervals = new Set<ReturnType<typeof setInterval>>();
  setSurface({
    display: async (wanted) => {
      if (standard) {
        try {
          const answer = await bridge.request("ui/request-display-mode", { mode: wanted }) as Json;
          const now = setMode(answer?.mode);
          if (now && now !== mode) context.changed?.({ displayMode: now });
          return now ?? mode;
        } catch {
          // ChatGPT's own, below.
        }
      }
      await openai()?.requestDisplayMode?.({ mode: wanted }).catch(() => {});
      const now = setMode(openai()?.displayMode);
      if (now && now !== mode) context.changed?.({ displayMode: now });
      return now ?? mode;
    },
    tell: async (text) => {
      if (standard) {
        try {
          await bridge.request("ui/message", { role: "user", content: { type: "text", text } });
          return;
        } catch {
          // ChatGPT's own, below.
        }
      }
      await openai()?.sendFollowUpMessage?.({ prompt: text, scrollToBottom: true });
    },
    remind: async (text) => {
      if (standard) {
        try {
          await bridge.request("ui/update-model-context", { content: [{ type: "text", text }] });
          return;
        } catch {
          // ChatGPT's own, below.
        }
      }
      const api = openai();
      if (api?.updateModelContext) {
        await api.updateModelContext({ content: [{ type: "text", text }] });
      } else api?.setWidgetState?.({ note: text });
    },
    openLink: async (url) => {
      if (standard) {
        try {
          await bridge.request("ui/open-link", { url });
          return;
        } catch {
          // ChatGPT's own, below.
        }
      }
      const api = openai();
      if (api?.openExternal) api.openExternal({ href: url });
      else globalThis.open?.(url, "_blank", "noopener,noreferrer");
    },
    every: (ms) => {
      const timer = setInterval(() => {
        if (document.visibilityState === "visible") void client.refresh().catch(() => {});
      }, ms);
      intervals.add(timer);
      return () => {
        clearInterval(timer);
        intervals.delete(timer);
      };
    },
  });

  let shown: Observation | undefined;
  const show = () => {
    const observed = client.observe(meta.view, meta.item, {
      viewer: meta.viewer,
      hints: { ...meta.hints, mode, surface: "widget" },
      part: (part, key) => <Part key={key} part={part} />,
    });
    draw(<Part part={observed} />);
    const old = shown;
    shown = observed;
    void observed.ready.then(() => old?.close());
  };
  context.changed = (said) => {
    setTheme(said.theme);
    const now = setMode(said.displayMode);
    if (now && now !== mode) {
      mode = now;
      show();
    }
  };
  show();

  // Shown again (the conversation scrolled back to it, the app reopened): what it shows now.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void client.refresh().catch(() => {});
  });
  // Links to the web open the host's way; nothing navigates the widget itself.
  document.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a");
    if (!link || event.defaultPrevented || link.hasAttribute("download")) return;
    event.preventDefault();
    if (/^https?:$/.test(link.protocol)) void openLink(link.href);
  });
  // Its height, as it changes: the host sizes the frame to it.
  let told = 0;
  new ResizeObserver(() => {
    const height = Math.ceil(document.documentElement.scrollHeight);
    if (height === told) return;
    told = height;
    bridge.notify("ui/notifications/size-changed", {
      width: Math.ceil(document.documentElement.clientWidth),
      height,
    });
    openai()?.notifyIntrinsicHeight?.(height);
  }).observe(document.body);
  return client;
}

/** A widget's page: its frame is the host's, so the page has no height of its own to fill. */
const WIDGET_CSS = `
html, body { height: auto; min-height: 0; background: var(--background); }
#app { height: auto; }
.copilotz-widget-empty { min-height: 48px; }
`;
