/** Bind complete physical operations to the existing local raw-call tracker. */
import {
  captureStreamCalls,
  type RegisteredStreamPort,
} from "../execution/stream-capability.ts";
import type { OwnerCommandExecuteOptions } from "./boundary.ts";
import type { createLocalPortCalls } from "./local-port-calls.ts";
export function createLocalStreamPort(
  options: Readonly<{
    port?: RegisteredStreamPort;
    calls: Pick<ReturnType<typeof createLocalPortCalls>, "run">;
    invocation(): void;
    settlement(): void;
  }>,
): RegisteredStreamPort | undefined {
  const port = captureStreamCalls(options.port);
  if (!port) return undefined;
  const { calls, invocation, settlement } = options;
  async function run<T>(
    check: () => void,
    work: (execution: OwnerCommandExecuteOptions) => Promise<T>,
    callOptions: OwnerCommandExecuteOptions,
  ) {
    check();
    const result = await calls.run(work, callOptions);
    check();
    return result;
  }
  return {
    open(input, callOptions) {
      const copied = structuredClone(input);
      return run(
        invocation,
        (execution) => port.open(copied, execution),
        callOptions,
      );
    },
    append(input, callOptions) {
      const copied = structuredClone(input);
      return run(
        invocation,
        (execution) => port.append(copied, execution),
        callOptions,
      );
    },
    checkpoint(input, callOptions) {
      const copied = structuredClone(input);
      return run(
        invocation,
        (execution) => port.checkpoint(copied, execution),
        callOptions,
      );
    },
    close(input, callOptions) {
      const copied = structuredClone(input);
      return run(
        invocation,
        (execution) => port.close(copied, execution),
        callOptions,
      );
    },
    abort(input, callOptions) {
      const copied = structuredClone(input);
      return run(
        settlement,
        (execution) => port.abort(copied, execution),
        callOptions,
      );
    },
  };
}
