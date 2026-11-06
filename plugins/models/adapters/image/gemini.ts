/**
 * Gemini images (`gemini-3-pro-image`, `gemini-3.1-flash-image`…):
 * `generateContent` asking for images as well as text, with the references
 * as inline parts after the prompt. A model makes one image a call, so
 * `count` images are as many calls, made together; what they made, said and
 * used is added up.
 */
import { post, type Usage, usageOf } from "../../shared/provider.ts";
import type { ImageAdapter, ImageAnswer, ImageRequest } from "../../shared/image.ts";
import { GEMINI } from "../llm/gemini.ts";

type Part = { text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string } };

type Answer = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string; finishMessage?: string }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: Record<string, number | undefined>;
};

/**
 * Finish reasons that are its rules saying no (`IMAGE_SAFETY`,
 * `PROHIBITED_CONTENT`, `RECITATION`…). Any other (`NO_IMAGE`, `IMAGE_OTHER`,
 * `STOP` with text only) is no image, which another model may still make.
 */
const REFUSAL = /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/;

/** Why it said no, and its words for it when it gives them. */
const why = (reason: string, message?: string) => message ? `${reason}: ${message}` : reason;

async function once(request: ImageRequest): Promise<ImageAnswer> {
  const { connection, options, prompt, references, aspectRatio, size, signal } = request;
  // A model's own `generationConfig` (and its `imageConfig`) goes over what's asked here.
  const { generationConfig: own, ...rest } = (options ?? {}) as {
    generationConfig?: { imageConfig?: Record<string, unknown> } & Record<string, unknown>;
  };
  const imageConfig = {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(size ? { imageSize: size } : {}),
    ...own?.imageConfig,
  };
  const response = await post(
    connection,
    GEMINI,
    `/models/${encodeURIComponent(connection.model)}:generateContent`,
    {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          ...references.map((image) => ({
            inlineData: { mimeType: image.type, data: image.data },
          })),
        ],
      }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...own,
        ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
      },
      ...rest,
    },
    signal,
  );
  const answer = await response.json() as Answer;
  const [candidate] = answer.candidates ?? [];
  const images: ImageAnswer["images"] = [];
  let text = "";
  for (const part of candidate?.content?.parts ?? []) {
    // Drafts it makes while it thinks: not what it made, and not billed.
    if (part.thought) continue;
    if (part.inlineData?.data) {
      images.push({ type: part.inlineData.mimeType ?? "image/png", data: part.inlineData.data });
    } else if (part.text) text += part.text;
  }
  const blocked = answer.promptFeedback?.blockReason;
  const finish = candidate?.finishReason;
  const refused = blocked
    ? why(blocked, answer.promptFeedback?.blockReasonMessage)
    : finish && REFUSAL.test(finish)
    ? why(finish, candidate?.finishMessage)
    : undefined;
  const usage = answer.usageMetadata;
  return {
    images,
    text,
    ...(refused && !images.length ? { refused } : {}),
    // As the llm adapter counts them: the prompt includes cached tokens; thoughts are output.
    ...(usage
      ? {
        usage: usageOf({
          input: usage.promptTokenCount ?? 0,
          output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          cached: usage.cachedContentTokenCount,
          reasoning: usage.thoughtsTokenCount,
        }),
      }
      : {}),
  };
}

/** Counts added up, keeping only those reported. */
const added = (a: Usage | undefined, b: Usage | undefined): Usage | undefined => {
  if (!a || !b) return a ?? b;
  const sum: Record<string, number> = {};
  for (const [key, value] of [...Object.entries(a), ...Object.entries(b)]) {
    if (typeof value === "number") sum[key] = (sum[key] ?? 0) + value;
  }
  return usageOf(sum as Usage);
};

export const gemini: ImageAdapter = {
  async generate(request) {
    const calls = await Promise.allSettled(
      Array.from({ length: request.count ?? 1 }, () => once(request)),
    );
    const answers = calls.flatMap((call) => call.status === "fulfilled" ? [call.value] : []);
    // None answered: the first failure is the call's. Some did: what they made (and cost).
    if (!answers.length) throw (calls[0] as PromiseRejectedResult).reason;
    const images = answers.flatMap((answer) => answer.images);
    const refused = answers.find((answer) => answer.refused)?.refused;
    const usage = answers.reduce<Usage | undefined>(
      (sum, answer) => added(sum, answer.usage),
      undefined,
    );
    return {
      images,
      text: answers.map((answer) => answer.text).filter(Boolean).join("\n"),
      ...(refused && !images.length ? { refused } : {}),
      ...(usage ? { usage } : {}),
    };
  },
};
