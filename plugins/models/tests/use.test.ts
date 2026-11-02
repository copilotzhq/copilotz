/** Who hears a model's use is waited for, so what it records goes with its job; one failing harms nothing. */
import { assertEquals } from "@std/assert";
import { used } from "../shared/use.ts";
import { test } from "../../../testing/mod.ts";

const use = { meter: "llm", subject: "fake/echo", quantities: { input: 1 } };

test("a use's listeners are waited for, and one that fails leaves the others and the call alone", async () => {
  const heard: string[] = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    await used({
      resources: {
        modelUse: {
          slow: {
            used: async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              heard.push("slow");
            },
          },
          broken: { used: () => Promise.reject(new Error("no")) },
          quick: { used: () => void heard.push("quick") },
        },
      },
    }, use);
  } finally {
    console.error = quiet;
  }
  assertEquals(heard, ["quick", "slow"]);
});
