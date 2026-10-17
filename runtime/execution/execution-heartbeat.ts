/** Internal transport-neutral lease timer. Relative timing never grants owner
 * authority. A duplicate or late renewal cannot extend this local budget. */
export function createExecutionHeartbeat<R>(
  input: Readonly<{
    reference: R;
    lease: Readonly<{ remainingMs: number; renewAfterMs: number }>;
    started: number;
    renew(reference: R, options: { signal: AbortSignal }): Promise<
      Readonly<{
        status: "committed" | "duplicate";
        result: R & {
          lease: Readonly<{ remainingMs: number; renewAfterMs: number }>;
        };
      }>
    >;
    /** Validate the complete response and compare its exact reference. */
    validate(
      result: R & {
        lease: Readonly<{ remainingMs: number; renewAfterMs: number }>;
      },
      expected: R,
    ): void;
    fail(error: unknown): void;
  }>,
) {
  let stopped = false;
  let wake: (() => void) | undefined;
  let deadline = 0;
  let next = 0;
  const lost = () =>
    Object.assign(new Error("registered_worker_renewal_unknown"), {
      name: "RegisteredWorkerError",
      code: "registered_worker_renewal_unknown",
      indeterminate: true,
    });
  const update = (lease: typeof input.lease, started: number) => {
    if (
      !lease || Object.keys(lease).length !== 2 ||
      !Number.isSafeInteger(lease.remainingMs) || lease.remainingMs <= 0 ||
      !Number.isSafeInteger(lease.renewAfterMs) || lease.renewAfterMs <= 0 ||
      lease.renewAfterMs >= lease.remainingMs
    ) {
      throw Object.assign(new Error("registered_worker_lease_invalid"), {
        name: "RegisteredWorkerError",
        code: "registered_worker_lease_invalid",
      });
    }
    deadline = started + lease.remainingMs;
    next = Math.min(started + lease.renewAfterMs, deadline);
    if (deadline <= performance.now()) throw lost();
  };
  update(input.lease, input.started);
  const loop = (async () => {
    try {
      while (!stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.max(0, Math.min(2_147_483_647, next - performance.now())),
          );
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (stopped) return;
        const started = performance.now();
        const budget = deadline - started;
        if (budget <= 0) throw lost();
        const control = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timeoutFailure: ReturnType<typeof lost> | undefined;
        try {
          const result = await Promise.race([
            input.renew(structuredClone(input.reference), {
              signal: control.signal,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timeoutFailure = lost();
                reject(timeoutFailure);
                control.abort(timeoutFailure);
              }, Math.min(2_147_483_647, budget));
            }),
          ]);
          if (timeoutFailure) throw timeoutFailure;
          if (result.status !== "committed") throw lost();
          input.validate(result.result, input.reference);
          if (performance.now() >= deadline) throw lost();
          update(structuredClone(result.result.lease), started);
        } catch (error) {
          throw timeoutFailure ?? error;
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      stopped = true;
      input.fail(error);
    }
  })();
  return {
    check() {
      if (!stopped && performance.now() >= deadline) throw lost();
    },
    requestStop() {
      stopped = true;
      wake?.();
    },
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
