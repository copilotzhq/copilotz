/** OpenAI transcription: POST /audio/transcriptions (multipart). */
import { post } from "../../shared/provider.ts";
import { OPENAI } from "../llm/openai-compatible.ts";
import type { TranscriptionAdapter } from "../../shared/transcribe.ts";

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

export const openai: TranscriptionAdapter = {
  async transcribe({ connection, options, audio, signal }) {
    const form = new FormData();
    const base = audio.type.split(";")[0].trim();
    const filename = audio.filename ?? `audio.${EXTENSIONS[base] ?? "webm"}`;
    form.set("file", new File([audio.data as BlobPart], filename, { type: base }));
    form.set("model", connection.model);
    form.set("response_format", "json");
    if (audio.language) form.set("language", audio.language);
    if (audio.prompt) form.set("prompt", audio.prompt);
    for (const [name, value] of Object.entries(options ?? {})) form.set(name, value);
    const response = await post(connection, OPENAI, "/audio/transcriptions", form, signal);
    const body = await response.json() as {
      text?: string;
      // Token-billed models report tokens; whisper-1 reports seconds of audio.
      usage?: { type?: string; input_tokens?: number; output_tokens?: number; seconds?: number };
    };
    const usage = body.usage;
    return {
      text: body.text ?? "",
      ...(usage
        ? {
          usage: usage.type === "duration"
            ? { input: 0, output: 0, seconds: usage.seconds ?? 0 }
            : { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 },
        }
        : {}),
    };
  },
};
