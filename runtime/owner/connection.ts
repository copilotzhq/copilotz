/** Application command bindings on Oxian's existing reverse work streams.
 * Private structural ports let the published package remain on its released
 * dependency until the separately reviewed transport change is published. */
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandOutcome,
  OwnerIdentityDomain,
  OwnerJson,
  OwnerReceipt,
} from "./boundary.ts";
import { assertJsonValue } from "../json.ts";

const COMMAND = "copilotz.owner.command";
const RECEIPT = "copilotz.owner.receipt";
const LIMIT = 1_100_000;
const ERROR_CODES = new Set([
  "ActionOwnershipLost",
  "owner_command_invalid",
  "owner_not_acquired",
  "owner_stopped",
  "owner_schema_owner_conflict",
  "owner_admission_refused",
  "owner_intent_conflict",
  "owner_command_closed",
  "owner_transaction_control_forbidden",
  "owner_commit_unknown",
  "persistence_indeterminate",
  "owner_call_rejected",
]);
type JsonObject = Readonly<Record<string, OwnerJson>>;

export type OwnerHostCaller = (
  input: Readonly<{
    workload: string;
    metadata?: JsonObject;
    body?: Uint8Array | ReadableStream<Uint8Array>;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }>,
) => Promise<
  Readonly<{
    output: ReadableStream<Uint8Array>;
    completed: Promise<void>;
    cancel(reason?: string): Promise<void>;
  }>
>;
export type OwnerWorkerCallContext = Readonly<{
  workload: string;
  metadata: JsonObject;
  signal: AbortSignal;
  fence: Readonly<
    {
      identity: Readonly<
        { workerId: string; attemptId: string; epoch: number }
      >;
      connectionId: string;
      sessionGeneration: number;
    }
  >;
  parent?: Readonly<
    {
      operationId: string;
      streamId: string;
      workload: string;
      metadata: JsonObject;
    }
  >;
}>;
type RecoveryReceipt = Pick<OwnerReceipt, "kind" | "result">;
type ReceiptIdentity = Readonly<{ domain: OwnerIdentityDomain; key: string }>;
type HostHandler = (
  input: Readonly<{ input: ReadableStream<Uint8Array>; signal: AbortSignal }>,
) => Promise<Uint8Array>;

function encode(value: unknown): Uint8Array {
  assertJsonValue(value, { maxDepth: 68, maxNodes: LIMIT });
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > LIMIT) {
    throw new RangeError("Owner call exceeds its byte limit.");
  }
  return bytes;
}
async function read(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<unknown> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(
      signal?.reason ?? new DOMException("Owner call aborted.", "AbortError"),
    );
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIMIT) {
        throw new RangeError("Owner call exceeds its byte limit.");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    assertJsonValue(value, { maxDepth: 68, maxNodes: LIMIT });
    return value;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an owner call object.");
  }
  return value as Record<string, unknown>;
}
function receiptIdentity(value: unknown): ReceiptIdentity {
  const input = object(value);
  if (
    Object.keys(input).some((key) => !["domain", "key"].includes(key)) ||
    !["logical", "incarnation", "occurrence"].includes(String(input.domain)) ||
    typeof input.key !== "string" || !input.key.trim()
  ) throw new TypeError("Invalid receipt identity.");
  return input as ReceiptIdentity;
}

/** Returns separate admissions suitable for Oxian workerCalls. No effects occur
 * until the admitted handler runs. A missing named holder never falls back. */
export function createOwnerWorkerCallAdmission(
  options: Readonly<{
    resolveOwner(ownerId: string): OwnerCommandBoundary | undefined;
    /** Resolve host-owned assignment state and grants, not request metadata.
     * Current session/execution/policy must also be checked inside boundary.authorize. */
    resolveAssignment(
      context: OwnerWorkerCallContext,
      ownerId: string,
    ):
      | Readonly<{ ownerId: string; ctxGranted: boolean; caller: OwnerCaller }>
      | undefined
      | Promise<
        | Readonly<
          { ownerId: string; ctxGranted: boolean; caller: OwnerCaller }
        >
        | undefined
      >;
  }>,
) {
  const admit = async (
    context: OwnerWorkerCallContext,
    recoveryOnly: boolean,
  ): Promise<HostHandler | undefined> => {
    if (context.workload !== COMMAND && context.workload !== RECEIPT) {
      return undefined;
    }
    if (recoveryOnly && context.workload !== RECEIPT) return undefined;
    const ownerId = context.metadata.ownerId;
    if (
      typeof ownerId !== "string" || !ownerId.trim() ||
      Object.keys(context.metadata).some((key) => key !== "ownerId")
    ) return undefined;
    const owner = options.resolveOwner(ownerId);
    if (!owner) return undefined;
    const isCommand = context.workload === COMMAND;
    if (isCommand && !context.parent) return undefined;
    const assignment = isCommand
      ? await options.resolveAssignment(context, ownerId)
      : undefined;
    if (
      isCommand &&
      (!assignment || assignment.ownerId !== ownerId ||
        assignment.ctxGranted !== true)
    ) return undefined;
    const caller = isCommand
      ? assignment!.caller
      : { workerId: context.fence.identity.workerId, ownerEpoch: 0 };
    if (!caller || caller.workerId !== context.fence.identity.workerId) {
      return undefined;
    }
    const admitted = structuredClone(caller);
    return async ({ input, signal }) => {
      let committed = false;
      try {
        signal.throwIfAborted();
        const payload = await read(input, signal);
        signal.throwIfAborted();
        const result = isCommand
          ? await owner.execute(admitted, object(payload) as OwnerCommand, {
            signal,
          })
          : await owner.readReceipt(admitted, receiptIdentity(payload));
        committed = isCommand;
        const reply = !isCommand && result
          ? {
            kind: (result as OwnerReceipt).kind,
            result: (result as OwnerReceipt).result,
          }
          : result;
        return encode({ ok: true, value: reply ?? null });
      } catch (error) {
        // SQL, grants and protected values must never leak via error strings.
        const code = error && typeof error === "object" && "code" in error &&
            typeof error.code === "string"
          ? error.code
          : "owner_call_rejected";
        return encode({
          ok: false,
          outcome: committed ||
              (error !== null && typeof error === "object" &&
                "indeterminate" in error && error.indeterminate === true) ||
              ["owner_commit_unknown", "persistence_indeterminate"].includes(
                code,
              )
            ? "unknown"
            : "refused",
          code: ERROR_CODES.has(code) ? code : "owner_call_rejected",
        });
      }
    };
  };
  return {
    admit: (context: OwnerWorkerCallContext) => admit(context, false),
    admitUnassigned: (context: OwnerWorkerCallContext) => admit(context, true),
  };
}

export class OwnerCallRejected extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "unknown" | "refused" = "refused",
  ) {
    super(
      outcome === "unknown"
        ? "Owner outcome is unknown; recover the receipt before retrying."
        : "The owner rejected the call.",
    );
    this.name = "OwnerCallRejected";
  }
}

/** No persistence and no retry loop live on the worker. A transport failure can
 * be indeterminate; callers recover an application receipt before retrying. */
export function createOwnerConnection(
  options: Readonly<{ ownerId: string; callHost: OwnerHostCaller }>,
) {
  if (!options.ownerId.trim()) throw new TypeError("Owner ID is required.");
  const ownerId = options.ownerId;
  const callHost = options.callHost;
  async function call(
    workload: string,
    payload: unknown,
    callOptions: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }> = {},
  ): Promise<unknown> {
    callOptions.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(callOptions.signal?.reason);
    callOptions.signal?.addEventListener("abort", abort, { once: true });
    if (callOptions.signal?.aborted) abort();
    const signal = controller.signal;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let handle: Awaited<ReturnType<OwnerHostCaller>> | undefined;
    let transportComplete = false;
    try {
      const opening = callHost({
        workload,
        metadata: { ownerId },
        body: encode(payload),
        ...callOptions,
        signal,
      });
      void opening.then((late) => {
        if (signal.aborted) {
          void late.cancel("owner call cancelled").catch(() => undefined);
        }
      }, () => undefined);
      handle = await Promise.race([opening, aborted]);
      // A rejected terminal must interrupt a stalled output stream immediately.
      const terminalFailure = handle.completed.then(() =>
        new Promise<never>(() => {})
      );
      const reply = object(
        await Promise.race([
          read(handle.output, signal),
          terminalFailure,
          aborted,
        ]),
      );
      await Promise.race([handle.completed, aborted]);
      transportComplete = true;
      if (reply.ok === false && typeof reply.code === "string") {
        throw new OwnerCallRejected(
          reply.code,
          reply.outcome === "unknown" ? "unknown" : "refused",
        );
      }
      if (reply.ok !== true || !("value" in reply)) {
        throw new TypeError("Invalid owner reply.");
      }
      return reply.value;
    } catch (error) {
      // A decoded application refusal after terminal completion needs no wire
      // cancellation; a late Cancel can target an already retired stream.
      if (!transportComplete) {
        controller.abort(error);
        void handle?.cancel("owner call failed").catch(() => undefined);
      }
      throw error;
    } finally {
      callOptions.signal?.removeEventListener("abort", abort);
      signal.removeEventListener("abort", onAbort);
    }
  }
  return {
    async execute(
      command: OwnerCommand,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerCommandOutcome> {
      return await call(COMMAND, command, callOptions) as OwnerCommandOutcome;
    },
    async readReceipt(
      identity: ReceiptIdentity,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<RecoveryReceipt | undefined> {
      return (await call(RECEIPT, identity, callOptions) ?? undefined) as
        | RecoveryReceipt
        | undefined;
    },
  };
}
