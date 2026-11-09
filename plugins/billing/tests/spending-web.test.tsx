/**
 * Spending on the web, as Copilotz's own front ends say it, whatever pays: a stop message isn't
 * the agent failing, a call someone else pays for says so, and a computer refused for what the org
 * can spend (the `spending` port: an app's credits) says so plainly, and who can help.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { failedOwn } from "../../agents/chat/views/web/message.tsx";
import { paidBy } from "../usage/views/web/org.tsx";
import { sizesOf } from "../../compute/cloud/views/web/cloud.ts";
import { NewCloud } from "../../compute/cloud/views/web/new.tsx";

const call = () => Promise.resolve({} as never);

const text = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();

test("a stop message isn't the agent failing; one that says so is", () => {
  assertEquals(failedOwn({ from: "maya", text: "maya failed: the model said no" }), true);
  assertEquals(failedOwn({ from: "maya", text: "" }), true);
  assertEquals(failedOwn({ from: "maya", text: "This org is out of credits." }), false);
});

test("a call someone else pays for says so, rather than $0", () => {
  assertEquals(paidBy({ paid: "own-key" })?.label, "Your key");
  assertEquals(paidBy({ paid: "subscription" })?.label, "Plan");
  assertEquals(paidBy({}), undefined);
  assertEquals(paidBy(undefined), undefined);
});

test("a computer refused for what the org can spend says so plainly, and who can help", () => {
  const sizes = sizesOf({
    sizes: [{ id: "s", vcpu: 2, memory: 4, perHour: 0.1 }],
    create: false,
    why: "credits",
  });
  const out = text(<NewCloud space="s" sizes={sizes} call={call} />);
  assertStringIncludes(out, "This org is out of credits");
  assertStringIncludes(out, "Your computers and files are safe");
  assertStringIncludes(out, "Go to Billing");
});
