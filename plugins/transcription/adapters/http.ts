/** Bounded prerecorded transcription HTTP transports. @module */
export type TranscriptionHttpInput = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  model: string;
  apiKey: string;
  languageCodes?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}>;
export type TranscriptionHttpResult = Readonly<{ text: string; model: string }>;

function validate(input: TranscriptionHttpInput): AbortSignal {
  if (!input.bytes.length || input.bytes.length > 25_000_000) {
    throw new Error("Transcription audio must contain 1–25000000 bytes.");
  }
  if (!input.model.trim() || !input.apiKey.trim()) {
    throw new Error("Transcription model and credentials are required.");
  }
  if (!/^audio\/[a-z0-9.+-]+$/i.test(input.mimeType)) {
    throw new Error("Transcription requires an audio MIME type.");
  }
  const timeout = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new Error("Transcription timeout must be 1–120000 milliseconds.");
  }
  const signals = [AbortSignal.timeout(timeout)];
  if (input.signal) signals.push(input.signal);
  const signal = AbortSignal.any(signals);
  signal.throwIfAborted();
  return signal;
}

/** Bounds injected transports too, and disposes responses arriving after abort. */
async function send(
  transport: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const work = transport(url, init);
  void work.then((response) => {
    if (signal.aborted) void response.body?.cancel().catch(() => {});
  }, () => {});
  return await new Promise<Response>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort)
    );
    if (signal.aborted) abort();
  });
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    // Provider bodies can contain private content; do not incorporate them in errors.
    throw new Error(`Transcription provider returned HTTP ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid transcription response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          reader.read().then(resolve, reject).finally(() =>
            signal.removeEventListener("abort", abort)
          );
        },
      );
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.length;
      if (size > 1_000_000) {
        throw new Error("Transcription response exceeds byte limit.");
      }
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Invalid transcription response JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid transcription response.");
  }
  return value as Record<string, unknown>;
}

/** OpenAI recorded-file endpoint; transport can be injected for contract tests. */
export async function transcribeOpenAi(
  input: TranscriptionHttpInput,
  transport: typeof fetch = fetch,
): Promise<TranscriptionHttpResult> {
  const signal = validate(input);
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
    input.filename,
  );
  form.set("model", input.model);
  form.set("response_format", "json");
  if (input.languageCodes?.length) {
    if (input.model === "gpt-transcribe") {
      for (const language of input.languageCodes) {
        form.append("languages[]", language);
      }
    } else {
      if (input.languageCodes.length !== 1) {
        throw new Error("This model accepts one language hint.");
      }
      form.set("language", input.languageCodes[0]);
    }
  }
  const result = await responseJson(
    await send(transport, "https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal,
    }, signal),
    signal,
  );
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("Transcription returned no speech text.");
  }
  return { text: result.text, model: input.model };
}

/** Stateless Gemini Interactions transcription, distinct from generateContent. */
export async function transcribeGemini(
  input: TranscriptionHttpInput,
  transport: typeof fetch = fetch,
): Promise<TranscriptionHttpResult> {
  const signal = validate(input);
  let binary = "";
  for (let offset = 0; offset < input.bytes.length; offset += 8192) {
    binary += String.fromCharCode(
      ...input.bytes.subarray(offset, offset + 8192),
    );
  }
  const result = await responseJson(
    await send(
      transport,
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": input.apiKey,
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          model: input.model,
          store: false,
          input: [{
            type: "audio",
            data: btoa(binary),
            mime_type: input.mimeType,
          }],
          generation_config: {
            transcription_config: {
              mode: { type: "verbatim" },
              ...(input.languageCodes?.length
                ? { language_codes: input.languageCodes }
                : {}),
            },
          },
        }),
      },
      signal,
    ),
    signal,
  );
  if (result.status !== "completed" || !Array.isArray(result.steps)) {
    throw new Error("Transcription did not complete.");
  }
  const text: string[] = [];
  for (const raw of result.steps) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    if (
      step.type === "model_output" && step.status !== undefined &&
      step.status !== "done"
    ) throw new Error("Transcription did not complete.");
    if (
      step.type !== "model_output" ||
      (step.status !== undefined && step.status !== "done") ||
      !Array.isArray(step.content)
    ) continue;
    for (const rawPart of step.content) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") {
        text.push(part.text);
      }
    }
  }
  const transcript = text.join("\n");
  if (!transcript.trim()) {
    throw new Error("Transcription returned no speech text.");
  }
  return { text: transcript, model: input.model };
}
