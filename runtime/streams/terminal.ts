import { isStreamTerminalStatus } from "./observation.ts";
import type { StreamErrorOutput, StreamTerminalStatus } from "./types.ts";

/** Projects catalog settlement into a bounded runtime-neutral error boundary. */
export function streamErrorOutput(
  streamIdInput: string,
  terminal: StreamTerminalStatus,
): StreamErrorOutput | null {
  const streamId = streamIdInput.trim();
  if (!streamId) throw new TypeError("Stream terminal id must be non-empty.");
  if (!isStreamTerminalStatus(terminal)) {
    throw new TypeError("Stream terminal status is invalid.");
  }
  if (
    terminal.outcome === "completed" &&
    terminal.availability === "retained"
  ) return null;
  const code = terminal.availability !== "retained"
    ? "stream_unavailable" as const
    : terminal.outcome === "failed"
    ? "stream_failed" as const
    : "stream_cancelled" as const;
  return ({
    type: "stream.error",
    streamId,
    offset: terminal.offset,
    code,
    outcome: terminal.outcome,
    availability: terminal.availability,
    ...(terminal.reason ? { reason: terminal.reason } : {}),
    ...(terminal.availabilityReason
      ? { availabilityReason: terminal.availabilityReason }
      : {}),
    terminalAt: terminal.terminalAt,
  } as const);
}
