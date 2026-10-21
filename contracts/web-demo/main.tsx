/** The demo app root: a browser runtime over fixture data. @module */
import {
  createBrowserRuntime,
  localStorageAdapter,
} from "@copilotz/copilotz/web";
import { reactRenderer } from "@copilotz/copilotz/web/react";
import {
  browserShellHistory,
  shellNavigation,
  shellUrlStorageAdapter,
  uiWebPlugin,
} from "@copilotz/copilotz/ui/web";
import type { BrowserRuntime } from "@copilotz/copilotz/web";
import { FixtureLive } from "../../plugins/ui/tests/fixture-live.test.ts";
import { fixtures } from "./fixtures.ts";
import { demoActions, DemoFeed, playLaunchReply } from "./host.ts";
import { demoApp } from "./app.tsx";

const url = new URL(location.href);
const live = new FixtureLive(fixtures());
const feed = new DemoFeed(live);
const runtime: BrowserRuntime = await createBrowserRuntime({
  plugins: [
    uiWebPlugin({ navigation: "url", preferences: "local" }),
    demoApp,
  ],
  live,
  actions: demoActions(live, feed),
  adapters: { core: { feed } },
  storage: {
    url: shellUrlStorageAdapter(
      browserShellHistory(
        globalThis as unknown as Parameters<typeof browserShellHistory>[0],
      ),
    ),
    local: localStorageAdapter(localStorage, "copilotz-demo:"),
  },
  renderer: reactRenderer,
  show: shellNavigation(() => runtime),
  onError: (error) => console.error(error),
});
const root = (globalThis as unknown as {
  document: { getElementById(id: string): unknown };
}).document.getElementById("root");
runtime.mount(root, { shows: "shell", value: null });
if (url.searchParams.get("stream") !== "0") {
  void playLaunchReply(feed, {
    freeze: url.searchParams.get("freeze") === "1",
    pace: Number(url.searchParams.get("pace") ?? "1"),
  });
}
(globalThis as Record<string, unknown>).demo = { runtime, live, feed };
