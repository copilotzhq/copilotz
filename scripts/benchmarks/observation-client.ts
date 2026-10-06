import { pause, repositoryRoot } from "./observation-native.ts";
const {
  decodeObservation,
  RenewalObservationError,
  TruncatedObservationError,
} = await import(repositoryRoot + "/client/protocol.ts");
import process from "node:process";
const viewers = Number(Deno.args[0]),
  active = Number(Deno.args[1]),
  recordBytes = Number(Deno.args[2]),
  slow = Deno.args[3] === "slow";
const endpoint = Deno.args[4];
if (!endpoint || new URL(endpoint).hostname !== "127.0.0.1") {
  throw new Error("The benchmark client requires the local harness endpoint.");
}
let ready = 0, stop = false, drained = false, recovering = false;
let received = 0, gaps = 0, duplicates = 0, renewals = 0, reconnects = 0;
const arrivals: {
  viewer: number;
  stream: string;
  sequence: number;
  at: number;
  offset: number;
}[] = [];
const errors: string[] = [];
const controllers = new Set<AbortController>();
const offsets = new Map<string, number>();
const checkpoints = new Map<number, string>();
const started = process.cpuUsage();
const loops = Array.from({ length: viewers }, (_, viewer) =>
  (async () => {
    let registered = false;
    const buffers = new Map<string, Uint8Array>();
    const sequences = new Map<string, number>();
    while (!stop) {
      const abort = new AbortController();
      controllers.add(abort);
      try {
        const checkpoint = checkpoints.get(viewer);
        const response = await fetch(
          `${endpoint}/observe?thread=thread-${viewer + 1}${
            checkpoint ? "&checkpoint=" + encodeURIComponent(checkpoint) : ""
          }`,
          { signal: abort.signal },
        );
        if (!response.ok) throw new Error(await response.text());
        if (!registered) {
          registered = true;
          ready++;
        } else reconnects++;
        for await (const frame of decodeObservation(response)) {
          if (stop) break;
          if (slow && viewer % 10 === 0 && !recovering) {
            while (!recovering && !stop) await pause(50);
          }
          if (frame.kind === "stream-chunk") {
            const key = viewer + "#" + frame.streamId;
            const old = offsets.get(key) ?? 0;
            if (frame.offset < old) {
              duplicates++;
            }
            if (frame.offset > old) gaps++;
            offsets.set(key, frame.offset + frame.bytes.length);
            const prior = buffers.get(frame.streamId) ?? new Uint8Array();
            const bytes = new Uint8Array(prior.length + frame.bytes.length);
            bytes.set(prior);
            bytes.set(frame.bytes, prior.length);
            let offset = 0;
            while (offset + recordBytes <= bytes.length) {
              const sequence = new DataView(
                bytes.buffer,
                bytes.byteOffset + offset,
                recordBytes,
              ).getUint32(0);
              const last = sequences.get(frame.streamId) ?? 0;
              if (sequence <= last) duplicates++;
              if (sequence !== last + 1) gaps++;
              sequences.set(frame.streamId, sequence);
              received++;
              arrivals.push({
                viewer,
                stream: frame.streamId,
                sequence,
                at: Date.now(),
                offset: frame.offset + offset + recordBytes - prior.length,
              });
              offset += recordBytes;
            }
            buffers.set(frame.streamId, bytes.slice(offset));
          }
          // This cursor follows the actual frame processing above, including deliberately slow viewers.
          checkpoints.set(viewer, frame.checkpoint);
        }
        if (!stop) {
          abort.abort();
          await pause(1);
        }
      } catch (error) {
        if (stop) break;
        if (error instanceof RenewalObservationError) {
          renewals++;
          continue;
        }
        if (error instanceof TruncatedObservationError) continue;
        errors.push(String(error));
        break;
      } finally {
        abort.abort();
        controllers.delete(abort);
      }
    }
  })());
while (ready < viewers && !errors.length) await pause(20);
await fetch(endpoint + "/ready", { method: "POST" });
while (!stop) {
  const status = await (await fetch(endpoint + "/status")).json();
  recovering = status.recovering;
  if (status.expected && received >= status.expected) {
    drained = true;
    await fetch(endpoint + "/drained", { method: "POST" });
  }
  if (status.stop) stop = true;
  else await pause(50);
}
for (const abort of controllers) abort.abort();
await Promise.allSettled(loops);
const cpu = process.cpuUsage(started);
console.log(
  JSON.stringify({
    viewers,
    active,
    received,
    gaps,
    duplicates,
    renewals,
    reconnects,
    drained,
    errors,
    arrivals,
    cpuMs: (cpu.user + cpu.system) / 1000,
    rssBytes: process.memoryUsage().rss,
  }),
);
Deno.exit(0);
