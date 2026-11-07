/**
 * Files to send, as tests make them: each uploaded on its own
 * (`chat.attach`, as `options` says), and what `chat.send` then takes for
 * them, by id.
 */
import type { Actor } from "../../../../runtime/mod.ts";

type Upload = { name: string; type?: string; data: string; voice?: { duration: number } };

/** Whatever calls Actions: a runtime, or a client as its person. */
type Caller = {
  call(action: string, input?: unknown, options?: { actor?: Actor }): Promise<unknown>;
};

export const attached = (
  caller: Caller,
  files: Upload[],
  options?: { actor?: Actor },
): Promise<{ id: string }[]> =>
  Promise.all(files.map(async (file) => {
    const { id } = await caller.call("chat.attach", file, options) as { id: string };
    return { id };
  }));
