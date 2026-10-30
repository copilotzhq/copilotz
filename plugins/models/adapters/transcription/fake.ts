/** Offline transcription (`"fake/<anything>"`): says what it heard, by size. For tests and demos. */
import type { TranscriptionAdapter } from "../../shared/transcribe.ts";

export const fake: TranscriptionAdapter = {
  transcribe: ({ audio }) =>
    Promise.resolve({ text: `(A recording, ${audio.data.length} bytes.)` }),
};
