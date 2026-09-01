import type { StreamErrorOutput, StreamTerminalStatus } from "./types.ts";

/** Projects catalog settlement into a bounded runtime-neutral error boundary. */
export function streamErrorOutput(
  streamIdInput: string,
  terminal: StreamTerminalStatus,
): StreamErrorOutput | null {
  const streamId = streamIdInput.trim();
  if (!streamId) throw new TypeError("Stream terminal id must be non-empty.");
  if (!Number.isSafeInteger(terminal.offset) || terminal.offset < 0) {
    throw new TypeError("Stream terminal offset is invalid.");
  }
  if (
    terminal.outcome === "completed" &&
    terminal.availability === "retained"
  ) return null;
  const code = terminal.availability !== "retained"
    ? "stream_unavailable" as const
    : terminal.outcome === "failed"
    ? "stream_failed" as const
    : terminal.outcome === "cancelled"
    ? "stream_cancelled" as const
    : terminal.outcome === "superseded"
    ? "stream_superseded" as const
    : "stream_abandoned" as const;
  return Object.freeze({
    type: "stream.error",
    streamId,
    offset: terminal.offset,
    code,
    outcome: terminal.outcome,
    availability: terminal.availability,
    capture: terminal.capture,
    terminalAt: terminal.terminalAt,
  });
}
