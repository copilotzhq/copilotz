import type { DeliveryDispatcher, DeliveryWorkload } from "./types.ts";

/** Colocated workloads keep their owner capabilities and never cross the wire. */
export function localDispatcher(
  workloads: Readonly<Record<string, DeliveryWorkload>>,
  capacity: number,
  workerId: string,
): DeliveryDispatcher & { drain(): Promise<void> } {
  let occupied = 0;
  const running = new Map<Promise<unknown>, AbortController>();
  return {
    async drain() {
      for (const abort of running.values()) {
        abort.abort(new Error("executor shutdown"));
      }
      await Promise.allSettled([...running.keys()]);
    },
    dispatch(input) {
      const handler = workloads[input.workload];
      if (!handler || input.target && input.target.workerId !== workerId) {
        return Promise.reject(
          new Error("Local workload placement is unavailable."),
        );
      }
      if (occupied >= capacity) {
        return Promise.reject(
          new Error("Local execution capacity is exhausted."),
        );
      }
      input.signal?.throwIfAborted();
      const captured = structuredClone(input.metadata ?? {});
      occupied++;
      const operationId = crypto.randomUUID(), streamId = crypto.randomUUID();
      const abort = new AbortController();
      const signal = input.signal
        ? AbortSignal.any([abort.signal, input.signal])
        : abort.signal;
      const metadata = Promise.withResolvers<
        Awaited<
          import("../../dependencies/oxian-work.ts").WorkHandle["metadata"]
        >
      >();
      const output = new TransformStream<Uint8Array, Uint8Array>();
      const writer = output.writable.getWriter();
      const body = input.body instanceof Uint8Array
        ? input.body.slice()
        : input.body;
      const openedAtMs = Date.now();
      const terminal = Promise.withResolvers<
        Awaited<
          import("../../dependencies/oxian-work.ts").WorkHandle["completed"]
        >
      >();
      const cancelled = () => ({
        operationId,
        workload: input.workload,
        metadata: captured,
        status: "cancelled" as const,
        deliveryCount: 1,
        openedAtMs,
        updatedAtMs: Date.now(),
      });
      const cancel = () => {
        metadata.resolve({});
        void writer.abort(signal.reason).catch(() => undefined);
        terminal.resolve(cancelled());
      };
      signal.addEventListener("abort", cancel, { once: true });
      const task = Promise.resolve().then(async () => {
        let status: "completed" | "failed" | "cancelled" = "completed";
        let message: string | undefined;
        try {
          const result = await handler({
            streamId,
            workload: input.workload,
            metadata: captured,
            signal,
            input: body instanceof ReadableStream ? body : new ReadableStream({
              start(controller) {
                if (body) controller.enqueue(body);
                controller.close();
              },
            }),
            sendMetadata(value) {
              metadata.resolve(value);
              return Promise.resolve();
            },
            callHost() {
              return Promise.reject(
                new Error("Local workloads use owner capabilities directly."),
              );
            },
          });
          const value =
            result instanceof Uint8Array || result instanceof ReadableStream
              ? { body: result }
              : result;
          metadata.resolve(value?.metadata ?? {});
          if (value?.body instanceof ReadableStream) {
            for await (const chunk of value.body) await writer.write(chunk);
          } else if (value?.body) await writer.write(value.body);
          signal.throwIfAborted();
          await writer.close();
        } catch (error) {
          status = signal.aborted ? "cancelled" : "failed";
          message = error instanceof Error ? error.message : String(error);
          metadata.resolve({});
          await writer.abort(error).catch(() => undefined);
        } finally {
          occupied--;
          signal.removeEventListener("abort", cancel);
        }
        return {
          operationId,
          workload: input.workload,
          metadata: captured,
          status,
          deliveryCount: 1,
          openedAtMs,
          updatedAtMs: Date.now(),
          ...(message ? { terminal: { message } } : {}),
        };
      });
      running.set(task, abort);
      void task.then(terminal.resolve, terminal.reject).finally(() =>
        running.delete(task)
      );
      const completed = terminal.promise;
      return Promise.resolve({
        operationId,
        streamId,
        metadata: metadata.promise,
        output: output.readable,
        started: Promise.resolve(),
        completed,
        cancel(reason) {
          abort.abort(new Error(reason ?? "cancelled"));
          return completed;
        },
      });
    },
  };
}
