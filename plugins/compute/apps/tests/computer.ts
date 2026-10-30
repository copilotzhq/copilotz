/**
 * A computer for apps' tests: it keeps the secret it's told, lists the jobs
 * it's given, and sends `archive` (a gzipped tar) as a folder, in chunks,
 * or the failure it's given instead, or stops partway, as the computer
 * program would.
 */
import { createWorker } from "@oxian/oxian-js";
import { type Job, WORK } from "../../computers/shared/workloads.ts";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const read = async <T>(input: ReadableStream<Uint8Array>) =>
  JSON.parse(await new Response(input).text()) as T;

export function archivingComputer(
  topic: string,
  first: string,
  options: {
    archive: Uint8Array;
    jobs?: Partial<Job>[];
    failArchive?: { message: string; code: string };
    /** Stops the archive partway, with this error, as the program does past `maxBytes`. */
    stopArchive?: string;
  },
) {
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
      ...answer(WORK.jobsList, () =>
        (options.jobs ?? []).map((job) => ({
          id: "j1",
          who: "agent:assistant",
          name: "server",
          command: "node server.js",
          pid: 1,
          running: true,
          exitCode: null,
          startedAt: new Date().toISOString(),
          ...job,
        }))),
      [WORK.archive]: async ({ input }: { input: ReadableStream<Uint8Array> }) => {
        asked.push({ work: WORK.archive, input: await read(input) });
        if (options.failArchive) return json({ error: options.failArchive });
        const bytes = options.archive;
        let at = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (options.stopArchive && at > 0) {
              return controller.error(new Error(options.stopArchive));
            }
            if (at >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(at, at + 64));
            at += 64;
          },
        });
      },
    },
  });
  return { worker, asked };
}
