/**
 * Says yes, as a person, to what agents wait on them for before sharing
 * (handing work to another space, a post beyond their work's bound), and
 * waits for what that sets going, until nothing more waits: for tests about
 * what comes after. Each yes is `answer` (this once, by default).
 */
import type { Actor, Runtime } from "../../../runtime/mod.ts";
import type { Approval } from "../chat/mod.ts";

export async function yesToShares(rt: Runtime, who: Actor, answer = "once"): Promise<number> {
  let said = 0;
  for (let round = 0; round < 10; round++) {
    const waiting = (await rt.query<Approval[]>("approval.pending", {}, { actor: who }))
      .filter((a) => a.work === "share");
    if (!waiting.length) break;
    for (const asked of waiting) {
      await rt.call("chat.approve", { approval: asked._id, answer }, { actor: who });
      said++;
    }
    await rt.idle();
  }
  return said;
}
