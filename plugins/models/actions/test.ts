/**
 * `llm.test` `{ model }`: one short call on a model the asker's own plan
 * pays for (a provider tagged `paid: "subscription"`: a person's ChatGPT
 * plan, a plan's CLI on their computer), to show the plan answers there: the
 * connect flow's last step. One model, never a list, so nothing falls to
 * another; the words are fixed. A model the app pays for is refused
 * (`invalid`): a test never spends the app's key. A failure keeps its code
 * (`engine_limit`, `engine_signed_out`, `account_needs_reconnect`…), for
 * whoever asked to say what to do. Answers `{ text, ms }`.
 */
import { defineAction, failure, inPerson } from "../../../runtime/mod.ts";
import { complete } from "../shared/generate.ts";
import { loadCatalog, resolve } from "../shared/choice.ts";

/** What a test asks. */
const ASK = "Answer with one word: ready.";

/** `llm.test`: see the module's doc. */
export const test = defineAction({
  description: "Tries one model your own plan pays for with a short question, to show it answers",
  record: false,
  input: {
    type: "object",
    properties: { model: { type: "string", pattern: "^[^/]+/.+" } },
    required: ["model"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await loadCatalog();
    const [chosen] = resolve(ctx.resources, input.model);
    if (chosen?.tags?.paid !== "subscription") {
      throw failure("invalid", `${input.model} isn't paid by a plan of yours: it isn't tried.`, {
        public: true,
      });
    }
    const started = Date.now();
    const answer = await complete(ctx, {
      model: input.model,
      instructions: "You're being checked: answer as asked, in one word.",
      messages: [{ role: "user", text: ASK }],
      tags: { purpose: "test" },
    });
    return { text: answer.text.trim(), ms: Date.now() - started };
  },
});
