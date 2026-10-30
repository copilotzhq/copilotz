/**
 * The offline providers: `"fake/<anything>"` echoes, calls a tool asked for
 * by name, and transcribes by size; `"hash/<anything>"` embeds by word
 * overlap only. For tests and demos.
 */
export const providers = {
  fake: { adapter: "fake", catalog: false },
  hash: { adapter: "hash", catalog: false },
};
