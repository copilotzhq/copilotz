/**
 * OpenAI images (`gpt-image-2`, `gpt-image-1.5`…): POST
 * /images/generations, or /images/edits (multipart) when there are images to
 * work from. `count` is its `n`; without a `size`, the shape comes from
 * `aspectRatio` (wide, tall or square). Its safety system saying no is a
 * refusal, not a failure.
 */
import { post, usageOf } from "../../shared/provider.ts";
import type { ImageAdapter } from "../../shared/image.ts";
import { OPENAI } from "../llm/openai-compatible.ts";

/** The size its models take for a shape, width to height. */
function sizeFor(aspectRatio?: string): string | undefined {
  if (!aspectRatio) return undefined;
  const [width, height] = aspectRatio.split(":").map(Number);
  return width > height ? "1536x1024" : width < height ? "1024x1536" : "1024x1024";
}

const REFUSED = /moderation_blocked|content_policy_violation|safety system/i;

/** Base64 to bytes, with web standards only. */
const bytesOf = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

export const openai: ImageAdapter = {
  async generate({ connection, options, prompt, references, count, aspectRatio, size, signal }) {
    const shape = size ?? sizeFor(aspectRatio);
    const fields: Record<string, unknown> = {
      model: connection.model,
      prompt,
      ...(count && count > 1 ? { n: count } : {}),
      ...(shape ? { size: shape } : {}),
      ...options,
    };
    let response: Response;
    try {
      if (references.length) {
        const form = new FormData();
        for (const [name, value] of Object.entries(fields)) form.set(name, String(value));
        references.forEach((image, i) => {
          const name = `reference-${i + 1}.${image.type.split("/")[1] ?? "png"}`;
          form.append("image[]", new File([bytesOf(image.data)], name, { type: image.type }));
        });
        response = await post(connection, OPENAI, "/images/edits", form, signal);
      } else response = await post(connection, OPENAI, "/images/generations", fields, signal);
    } catch (error) {
      const { status, message } = error as { status?: number; message?: string };
      if (status === 400 && REFUSED.test(message ?? "")) {
        return { images: [], text: "", refused: "moderation_blocked" };
      }
      throw error;
    }
    const body = await response.json() as {
      data?: { b64_json?: string }[];
      output_format?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
    };
    const format = body.output_format ?? String(options?.output_format ?? "png");
    const usage = body.usage;
    return {
      images: (body.data ?? []).flatMap((item) =>
        item.b64_json ? [{ type: `image/${format}`, data: item.b64_json }] : []
      ),
      text: "",
      ...(usage
        ? {
          usage: usageOf({
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cached: usage.input_tokens_details?.cached_tokens,
          }),
        }
        : {}),
    };
  },
};
