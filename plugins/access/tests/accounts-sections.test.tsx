/**
 * Your AI's sections (`accountSections`): other front ends' Views, shown first, in their order
 * (one taken out with `null` isn't), each given the address's query and the page's mode; then
 * the providers. One that shows the plans (`plans: true`) takes the providers that pay for
 * models: the rest are "Other accounts". With no provider to connect, the sections show alone.
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
const github: ProviderShown = {
  name: "github",
  title: "GitHub",
  allows: "Agents working for you read and push to your repositories.",
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

test("other front ends' sections show first, in order, with the address's query; then the providers", () => {
  const { ctx, shown } = ctxOf([chatgpt], SECTIONS, { connect: "claude-plan" });
  const markup = renderToStaticMarkup(<>{accountsView(undefined, ctx)}</>);
  assertEquals(shown.map((s) => s.name), ["other.first", "computer.plans", "accounts.keys"]);
  assertEquals(shown[1], {
    name: "computer.plans",
    item: {},
    hints: { query: { connect: "claude-plan" }, mode: "full" },
  });
  const first = markup.indexOf('data-view="other.first"');
  const plans = markup.indexOf('data-view="computer.plans"');
  const card = markup.indexOf("Connect ChatGPT");
  assert(first >= 0 && first < plans && plans < card, "each section in order, then the providers");
  assertStringIncludes(markup, "Your AI");
  assertEquals(sectionsOf(SECTIONS).map((s) => s.key), ["early", "plans"]);
  assertEquals(sectionsOf(undefined), []);
});

test("a section that shows the plans takes the providers that pay for models; the rest are Other accounts", () => {
  const { ctx } = ctxOf([chatgpt, github], {
    plans: { view: "computer.plans", order: 10, plans: true },
  }, {});
  const markup = renderToStaticMarkup(<>{accountsView(undefined, ctx)}</>);
  assert(!markup.includes("Connect ChatGPT"), "ChatGPT is one of the plans");
  assertStringIncludes(markup, "Other accounts");
  assertStringIncludes(markup, "Connect GitHub");
  assert(
    markup.indexOf('data-view="computer.plans"') < markup.indexOf("Other accounts"),
    "the plans first",
  );
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
