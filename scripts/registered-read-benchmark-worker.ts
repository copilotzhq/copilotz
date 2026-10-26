/** Isolates loader CPU from owner CPU for the read microbenchmark. */
import { turnContextRead } from "../plugins/core/shared/turn-context.ts";
type Message =
  | { kind: "result"; id: number; error?: string; value?: unknown }
  | {
    kind: "start";
    id: number;
    names: string[];
    mode: "owner" | "worker";
    input: Parameters<typeof turnContextRead.execute>[0];
    context: object;
  };
const channel = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage(event: { data: Message }): Promise<void>;
};
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(reason: unknown): void }
>();
let sequence = 0;
function request(
  task: number,
  path: string[],
  args: unknown[],
): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    channel.postMessage({ kind: "call", id, task, path, args });
  });
}
channel.onmessage = async ({ data }) => {
  if (data.kind === "result") {
    const wait = pending.get(data.id)!;
    pending.delete(data.id);
    if (data.error) wait.reject(new Error(data.error));
    else wait.resolve(data.value);
    return;
  }
  try {
    const collections = Object.fromEntries(
      data.names.map((name: string) => [name, {
        get: (...args: unknown[]) => request(data.id, [name, "get"], args),
        list: (...args: unknown[]) => request(data.id, [name, "list"], args),
      }]),
    );
    const value = data.mode === "owner"
      ? await request(data.id, [], [])
      : await turnContextRead.execute(
        data.input,
        {
          ...data.context,
          collections,
          signal: new AbortController().signal,
          now: () => new Date(),
        } as unknown as Parameters<typeof turnContextRead.execute>[1],
      );
    channel.postMessage({ kind: "done", id: data.id, value });
  } catch (error) {
    channel.postMessage({ kind: "done", id: data.id, error: String(error) });
  }
};
