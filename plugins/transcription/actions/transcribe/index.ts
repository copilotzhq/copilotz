/** Bounded prerecorded transcription using ordinary durable Action results. @module */
import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { ContentRef } from "@copilotz/copilotz/content";
import { transcribeGemini, transcribeOpenAi } from "../../adapters/http.ts";
export type TranscribeAudioInput = { assetId: string; connection: string };
export type TranscribeAudioOutput = {
  text: string;
  sourceAssetId: string;
  model: string;
};

/** Interrupts a pending host wait; underlying host cleanup remains host-owned. */
async function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort)
    );
  });
}
export const transcribeAudioAction: ActionDefinition<
  TranscribeAudioInput,
  TranscribeAudioOutput
> = defineAction({
  id: "copilotz.transcription.transcribe",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["assetId", "connection"],
    properties: {
      assetId: { type: "string", minLength: 1 },
      connection: { type: "string", minLength: 1 },
    },
  } as const,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text", "sourceAssetId", "model"],
    properties: {
      text: { type: "string" },
      sourceAssetId: { type: "string" },
      model: { type: "string" },
    },
  } as const,
  async execute(
    input: TranscribeAudioInput,
    context: ActionContext,
  ): Promise<TranscribeAudioOutput> {
    const connection = context.resources.transcription?.[input.connection] as {
      provider: "openai" | "gemini";
      model: string;
      maxBytes?: number;
      timeoutMs?: number;
      languageCodes?: string[];
    } | undefined;
    if (
      !connection || !["openai", "gemini"].includes(connection.provider) ||
      !connection.model?.trim()
    ) throw new Error("Unknown transcription connection.");
    const timeout = connection.timeoutMs ?? 30_000;
    const limit = connection.maxBytes ?? 25_000_000;
    if (
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 25_000_000
    ) throw new Error("Invalid transcription bounds.");
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(timeout),
    ]);
    signal.throwIfAborted();
    const credentials = context.adapters.transcription?.[input.connection] as {
      resolveApiKey: () => Promise<string>;
    } | undefined;
    if (!credentials?.resolveApiKey) {
      throw new Error("Missing transcription credential resolver.");
    }
    const asset = await wait(context.content.get(input.assetId), signal);
    if (
      !asset || asset.state !== "ready" ||
      !asset.mediaType.startsWith("audio/") || asset.byteLength > limit
    ) {
      throw new Error(
        "Transcription source unavailable or exceeds audio policy.",
      );
    }
    const ref: ContentRef = {
      assetId: asset.id,
      kind: "audio",
      role: "user",
      mediaType: asset.mediaType,
    };
    if (!context.content.authorize) {
      throw new Error("Transcription requires content authorization services.");
    }
    await wait(context.content.authorize(ref), signal);
    const opening = context.content.open(ref);
    // A late stream returned after cancellation must not remain acquired.
    void opening.then((stream) => {
      if (signal.aborted) void stream.cancel().catch(() => {});
    }, () => {});
    const reader = (await wait(opening, signal)).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await wait(reader.read(), signal);
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > limit) {
          throw new Error("Transcription source exceeds byte limit.");
        }
        chunks.push(chunk.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch { /* Pending host read cleanup is non-blocking. */ }
    }
    if (!size) throw new Error("Transcription source is empty.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const apiKey = await wait(credentials.resolveApiKey(), signal);
    signal.throwIfAborted();
    const result = await wait(
      (connection.provider === "openai" ? transcribeOpenAi : transcribeGemini)({
        bytes,
        mimeType: asset.mediaType.split(";", 1)[0],
        filename: `voice.${
          asset.mediaType.includes("webm") ? "webm" : "audio"
        }`,
        model: connection.model,
        apiKey,
        signal,
        timeoutMs: timeout,
        languageCodes: connection.languageCodes,
      }),
      signal,
    );
    signal.throwIfAborted();
    return { text: result.text, sourceAssetId: asset.id, model: result.model };
  },
});
export default transcribeAudioAction;
