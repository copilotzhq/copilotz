/**
 * Connected accounts' sections (`accountSections`): other front ends' Views, shown below the
 * providers in their order (one taken out with `null` isn't), each given the address's query and
 * the page's mode; with no provider to connect, the sections show alone.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { ProviderShown } from "../accounts/contract.ts";
import { accountsView, sectionsOf } from "../accounts/views/web/accounts.tsx";
import { test } from "../../../testing/mod.ts";

const chatgpt: ProviderShown = {
  name: "chatgpt",
  title: "ChatGPT",
  allows: "Agents working for you run on your ChatGPT plan.",
  models: ["chatgpt"],
};

function ctxOf(providers: ProviderShown[], sections: unknown, query: Record<string, string>) {
  const shown: { name: string; item: unknown; hints: unknown }[] = [];
  const ctx = {
    db: {
      collection: () => ({
        query: () => ({ status: "ready", value: providers }),
        find: () => ({ status: "ready", value: [] }),
      }),
    },
    resources: { accountSections: sections },
    name: "accounts",
    viewer: { name: "ana" },
    hints: { query },
    show: (name: string, item: unknown, hints: unknown) => {
      shown.push({ name, item, hints });
      return createElement("section", { "data-view": name });
    },
    call: () => Promise.resolve({} as never),
    emit: () => Promise.resolve(),
  } as unknown as ViewContext<ReactNode>;
  return { ctx, shown };
}

const SECTIONS = {
  plans: { view: "computer.plans", order: 10 },
  early: { view: "other.first", order: 1 },
  gone: null,
};

test("other front ends' sections show below the providers, in order, with the address's query", () => {
  const { ctx, shown } = ctxOf([chatgpt], SECTIONS, { signin: "claude" });
  const markup = renderToStaticMarkup(<>{accountsView(undefined, ctx)}</>);
  assertEquals(shown.map((s) => s.name), ["other.first", "computer.plans", "accounts.keys"]);
  assertEquals(shown[1], {
    name: "computer.plans",
    item: {},
    hints: { query: { signin: "claude" }, mode: "full" },
  });
  // Below the providers' cards.
  const card = markup.indexOf("Connect ChatGPT");
  const first = markup.indexOf('data-view="other.first"');
  const plans = markup.indexOf('data-view="computer.plans"');
  assert(card >= 0 && card < first && first < plans, "the providers, then each section in order");
  assertEquals(sectionsOf(SECTIONS).map((s) => s.key), ["early", "plans"]);
  assertEquals(sectionsOf(undefined), []);
});

test("with no provider to connect, the sections show alone", () => {
  const { ctx } = ctxOf([], { plans: { view: "computer.plans" } }, {});
  const markup = renderToStaticMarkup(<>{accountsView(undefined, ctx)}</>);
  assertStringIncludes(markup, 'data-view="computer.plans"');
  assert(!markup.includes("Nothing to connect yet"));
  // With none either, it says there's nothing to connect.
  const none = ctxOf([], {}, {});
  assertStringIncludes(
    renderToStaticMarkup(<>{accountsView(undefined, none.ctx)}</>),
    "Nothing to connect yet",
  );
});
