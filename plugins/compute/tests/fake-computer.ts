/**
 * A computer for tests: it does nothing but say what it was asked, and keeps
 * the secret it's told, as the computer program does.
 */
import { createWorker } from "@oxian/oxian-js";
import { WORK } from "../computers/shared/workloads.ts";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const read = async <T>(input: ReadableStream<Uint8Array>) =>
  JSON.parse(await new Response(input).text()) as T;

/**
 * One connecting on `topic` (in-process) with `first` (`code:<code>`, or
 * `<id>.<secret>`); `lose` answers `enrolled` with a failure, keeping
 * nothing, as a program that stopped before it saved its secret.
 */
export function fakeComputer(topic: string, first: string, options: { lose?: boolean } = {}) {
  const asked: { work: string; input: Record<string, unknown> }[] = [];
  let credential = first;
  const attempt = { attemptId: crypto.randomUUID(), epoch: Date.now() };
  const answer = (work: string, reply: (input: Record<string, unknown>) => unknown) => ({
    [work]: async ({ input }: { input: ReadableStream<Uint8Array> }) => {
      const given = await read<Record<string, unknown>>(input);
      asked.push({ work, input: given });
      return json(reply(given));
    },
  });
  const worker = createWorker({
    id: `computer-${crypto.randomUUID()}`,
    transport: { type: "in-process", config: { topic } },
    activate: ({ workerId }: { workerId: string }) => ({ identity: { workerId, ...attempt } }),
    register: () =>
      Promise.resolve({
        credential: { kind: "registration" as const, capability: `computer:${credential}` },
        expiresAtMs: Date.now() + 60_000,
      }),
    capacity: 8,
    workloads: {
      ...answer(WORK.enrolled, (input) => {
        if (options.lose) return { error: { message: "stopped", code: "failed" } };
        credential = `${input.id}.${input.secret}`;
        return {};
      }),
      ...answer(WORK.info, () => ({
        os: "testos",
        arch: "x64",
        hostname: "testbox",
        root: "/tmp/root",
        shell: "bash",
        browser: null,
        version: "test",
      })),
      ...answer(WORK.terminal, (input) => ({
        state: "idle",
        commandId: "c1",
        stdout: `ran ${input.stdin}`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        cwd: ".",
      })),
      ...answer(WORK.filesWrite, (input) => ({ size: String(input.content).length })),
      ...answer(WORK.filesList, () => []),
      ...answer(WORK.search, () => [
        { title: "Deno", url: "https://deno.com", snippet: "A runtime" },
      ]),
    },
  });
  return { worker, asked, credential: () => credential };
}
