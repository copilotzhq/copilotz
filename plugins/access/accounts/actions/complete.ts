/**
 * `account.complete`: finishes connecting from the address a provider sent
 * the person to, pasted back (the page there can't load: it's a
 * command-line tool's). The address holds the sign-in's code and state,
 * which must be the person's own sign-in, there, in time. Unrecorded: the
 * code stays out of the log. It answers the account, as its person sees it.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { invalid } from "../shared/errors.ts";
import { finish, where } from "../shared/flow.ts";
import { providerOf } from "../shared/settings.ts";

export const completeAction = defineAction({
  description: "Finishes connecting an account from the address its sign-in ended at",
  record: false,
  input: {
    type: "object",
    properties: { provider: { type: "string" }, address: { type: "string", maxLength: 16384 } },
    required: ["provider", "address"],
    additionalProperties: false,
  },
  allow: people,
  run: (ctx, input) => {
    const { title } = providerOf(ctx, input.provider);
    let url: URL;
    try {
      url = new URL(input.address.trim());
    } catch {
      throw invalid("That isn't an address: copy the whole address from the browser's address bar");
    }
    const q = url.searchParams;
    if (!q.get("code") && !q.get("error")) {
      throw invalid(
        `That address has no sign-in code: copy the address of the page ${title} sent you to`,
      );
    }
    return finish(ctx, input.provider, {
      code: q.get("code") ?? undefined,
      state: q.get("state") ?? undefined,
      error: q.get("error") ?? undefined,
      at: where(url.href),
    });
  },
});
