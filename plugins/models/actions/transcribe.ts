/** `transcription.transcribe`: speech to text from outside, with the audio as base64. */
import { defineAction } from "../../../runtime/mod.ts";
import type { ModelRef } from "../shared/choice.ts";
import { transcribe as transcribeAudio } from "../shared/transcribe.ts";

/** Base64 to bytes, with web standards only. */
const decodeBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export const transcribe = defineAction({
  input: {
    type: "object",
    properties: {
      model: { type: ["string", "object", "array"] },
      audio: { type: "string", description: "The audio, base64-encoded." },
      type: { type: "string" },
      filename: { type: "string" },
      language: { type: "string" },
      prompt: { type: "string" },
      /** What it's for (thread, purpose…): its usage record's tags. */
      tags: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["model", "audio", "type"],
    additionalProperties: false,
  },
  run: (ctx, { model, audio, tags, ...rest }) =>
    transcribeAudio(ctx, {
      model: model as ModelRef,
      audio: { ...rest, data: decodeBase64(audio) },
      ...(tags ? { tags: tags as Record<string, string> } : {}),
    }),
});
