import type {
  ChatContentPart,
  ChatMessage,
  ProviderConfig,
} from "@/runtime/llm/types.ts";
import { resolveModelCatalogEntry } from "@/runtime/llm/model-catalog.ts";
import { resolveOpenAIApiMode } from "@/runtime/llm/openai-api-mode.ts";
import {
  type AssetRef,
  type AssetStore,
  bytesToBase64,
  extractAssetId,
  isAssetRef,
  parseDataUrl,
  toDataUrl,
} from "@/runtime/storage/assets.ts";

type AdapterAssetSupport = {
  image: boolean;
  audio: boolean;
  file: boolean;
  video: boolean;
};

const MODEL_CATALOG_ASSET_TIMEOUT_MS = 750;

const SUPPORTED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const SUPPORTED_AUDIO_MIME = new Set([
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
]);

// MiniMax-M3 video input via the Anthropic-compatible Messages API.
const SUPPORTED_VIDEO_MIME = new Set([
  "video/mp4",
  "video/avi",
  "video/x-msvideo",
  "video/quicktime",
  "video/mov",
  "video/x-matroska",
]);

const ARCHIVE_MIME_PREFIXES = [
  "application/zip",
  "application/x-zip",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z",
  "application/x-rar",
  "application/vnd.rar",
];

type AssetSupportConfig =
  & Pick<ProviderConfig, "provider" | "model" | "pricingModelId">
  & Pick<ProviderConfig, "openaiApi">;

function providerAdapterSupport(
  config: Pick<ProviderConfig, "provider" | "model" | "openaiApi">,
): AdapterAssetSupport {
  switch (config.provider) {
    case "anthropic":
      return { image: true, audio: false, file: true, video: false };
    case "gemini":
      return { image: true, audio: true, file: true, video: false };
    case "openai":
      return {
        image: true,
        audio: false,
        file: resolveOpenAIApiMode(config) === "responses",
        video: false,
      };
    case "ollama":
      return { image: true, audio: false, file: false, video: false };
    case "minimax":
      // MiniMax-M3 accepts image and video via the Anthropic-compatible API.
      return { image: true, audio: false, file: false, video: true };
    default:
      return { image: false, audio: false, file: false, video: false };
  }
}

function hasInputModality(modalities: string[], modality: string): boolean {
  return modalities.some((candidate) =>
    candidate.toLowerCase() === modality.toLowerCase()
  );
}

async function resolveAssetSupport(
  config: AssetSupportConfig,
): Promise<AdapterAssetSupport> {
  const support = providerAdapterSupport(config);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const entry = await Promise.race([
    resolveModelCatalogEntry(config),
    new Promise<null>((resolve) => {
      timeoutId = setTimeout(
        () => resolve(null),
        MODEL_CATALOG_ASSET_TIMEOUT_MS,
      );
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
  const inputModalities = entry?.architecture?.inputModalities ?? [];
  if (inputModalities.length === 0) return support;

  // OpenRouter tells us what the model can accept; the adapter gate tells us
  // whether Copilotz can serialize that modality for the native provider API.
  return {
    image: support.image && hasInputModality(inputModalities, "image"),
    audio: support.audio && hasInputModality(inputModalities, "audio"),
    file: support.file && hasInputModality(inputModalities, "file"),
    video: support.video && hasInputModality(inputModalities, "video"),
  };
}

function isSupportedImageMime(mime?: string): mime is string {
  return typeof mime === "string" &&
    SUPPORTED_IMAGE_MIME.has(mime.toLowerCase());
}

function isSupportedAudioMime(mime?: string): mime is string {
  return typeof mime === "string" &&
    SUPPORTED_AUDIO_MIME.has(mime.split(";")[0].trim().toLowerCase());
}

function isSupportedFileMime(mime?: string): mime is string {
  return typeof mime === "string" && mime.toLowerCase() === "application/pdf";
}

function isSupportedVideoMime(mime?: string): mime is string {
  return typeof mime === "string" &&
    SUPPORTED_VIDEO_MIME.has(mime.toLowerCase());
}

function isArchiveMime(mime?: string): boolean {
  const lower = typeof mime === "string" ? mime.toLowerCase() : "";
  return ARCHIVE_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function audioFormatFromMime(mime?: string): string | undefined {
  const lower = typeof mime === "string"
    ? mime.split(";")[0].trim().toLowerCase()
    : "";
  if (lower === "audio/mpeg") return "mp3";
  if (lower === "audio/opus") return "ogg";
  if (lower === "audio/x-wav" || lower === "audio/wave") return "wav";
  if (!lower.includes("/")) return undefined;
  return lower.split("/")[1];
}

function omittedFileText(
  reason: string,
  mime?: string,
  assetRef?: string,
): string {
  const details = [
    mime ? `mime="${mime}"` : undefined,
    assetRef && isAssetRef(assetRef)
      ? `asset_id="${extractAssetId(assetRef)}"`
      : undefined,
    `reason="${reason}"`,
  ].filter(Boolean).join(" ");
  return `[Attached file omitted from direct LLM input: ${details}]`;
}

function unavailableAssetText(assetRef: string): string {
  return `[Attached file unavailable: asset_id="${extractAssetId(assetRef)}"]`;
}

function dataUrlMime(dataUrl: string): string | undefined {
  const parsed = parseDataUrl(dataUrl);
  return parsed?.mime;
}

function directDataPart(
  fileData: string,
  mime: string | undefined,
  support: AdapterAssetSupport,
  filename?: string,
): ChatContentPart[] {
  const parsed = fileData.startsWith("data:") ? parseDataUrl(fileData) : null;
  const actualMime = mime ?? parsed?.mime;

  if (
    isSupportedImageMime(actualMime) && support.image &&
    fileData.startsWith("data:")
  ) {
    return [{ type: "image_url", image_url: { url: fileData } }];
  }

  if (parsed && isSupportedAudioMime(parsed.mime) && support.audio) {
    return [{
      type: "input_audio",
      input_audio: {
        data: bytesToBase64(parsed.bytes),
        ...(audioFormatFromMime(parsed.mime)
          ? { format: audioFormatFromMime(parsed.mime) }
          : {}),
        ...(filename ? { filename } : {}),
      },
    }];
  }

  if (parsed && isSupportedFileMime(actualMime) && support.file) {
    return [{
      type: "file",
      file: {
        file_data: fileData,
        mime_type: actualMime,
        ...(filename ? { filename } : {}),
      },
    }];
  }

  if (
    isSupportedVideoMime(actualMime) && support.video &&
    fileData.startsWith("data:")
  ) {
    return [{ type: "video", video: { url: fileData, mime_type: actualMime } }];
  }

  const omittedReason = isArchiveMime(actualMime)
    ? "archive_tool_only"
    : "unsupported_file_type";
  return [{ type: "text", text: omittedFileText(omittedReason, actualMime) }];
}

async function resolveAssetRefPart(
  assetRef: AssetRef,
  kind: "image" | "audio" | "file",
  support: AdapterAssetSupport,
  store?: AssetStore,
  explicitMime?: string,
  filename?: string,
): Promise<ChatContentPart[]> {
  if (!store) {
    return [{ type: "text", text: unavailableAssetText(assetRef) }];
  }

  try {
    const { bytes, mime } = await store.get(extractAssetId(assetRef));
    const actualMime = mime || explicitMime;
    if (
      kind === "image" &&
      support.image &&
      isSupportedImageMime(actualMime)
    ) {
      return [{
        type: "image_url",
        image_url: { url: toDataUrl(bytes, actualMime) },
      }];
    }
    if (
      kind === "audio" &&
      support.audio &&
      isSupportedAudioMime(actualMime)
    ) {
      return [{
        type: "input_audio",
        input_audio: {
          data: bytesToBase64(bytes),
          ...(audioFormatFromMime(actualMime)
            ? { format: audioFormatFromMime(actualMime) }
            : {}),
          ...(filename ? { filename } : {}),
        },
      }];
    }
    if (kind === "file" && support.file && isSupportedFileMime(actualMime)) {
      return [{
        type: "file",
        file: {
          file_data: toDataUrl(bytes, actualMime),
          mime_type: actualMime,
          ...(filename ? { filename } : {}),
        },
      }];
    }

    // Video attachments arrive as `file` parts; route them to a video part
    // when the provider can serialize video input (MiniMax-M3).
    if (kind === "file" && support.video && isSupportedVideoMime(actualMime)) {
      return [{
        type: "video",
        video: {
          url: toDataUrl(bytes, actualMime),
          mime_type: actualMime,
        },
      }];
    }

    const omittedReason = isArchiveMime(actualMime)
      ? "archive_tool_only"
      : "unsupported_file_type";
    return [{
      type: "text",
      text: omittedFileText(omittedReason, actualMime, assetRef),
    }];
  } catch {
    return [{ type: "text", text: unavailableAssetText(assetRef) }];
  }
}

async function materializePart(
  part: ChatContentPart,
  support: AdapterAssetSupport,
  store?: AssetStore,
): Promise<ChatContentPart[]> {
  if (part.type === "text") return [part];

  if (part.type === "image_url" && part.image_url?.url) {
    const url = part.image_url.url;
    if (isAssetRef(url)) {
      return await resolveAssetRefPart(url, "image", support, store);
    }
    if (url.startsWith("data:")) {
      const mime = dataUrlMime(url);
      return isSupportedImageMime(mime) && support.image ? [part] : [{
        type: "text",
        text: omittedFileText("unsupported_image_type", mime),
      }];
    }
    // The OpenAI and Anthropic adapters can pass URLs through. Gemini currently
    // only maps inline data, but leaving a URL here preserves existing behavior.
    return support.image ? [part] : [];
  }

  if (part.type === "video" && part.video?.url) {
    const url = part.video.url;
    if (isAssetRef(url)) {
      return await resolveAssetRefPart(
        url,
        "file",
        support,
        store,
        part.video.mime_type,
      );
    }
    if (support.video) return [part];
    return [{
      type: "text",
      text: omittedFileText("unsupported_video_input", part.video.mime_type),
    }];
  }

  if (part.type === "input_audio" && part.input_audio?.data) {
    const data = part.input_audio.data;
    if (isAssetRef(data)) {
      return await resolveAssetRefPart(
        data,
        "audio",
        support,
        store,
        undefined,
        part.input_audio.filename,
      );
    }
    return support.audio ? [part] : [{
      type: "text",
      text: omittedFileText(
        "unsupported_audio_input",
        part.input_audio.format
          ? `audio/${part.input_audio.format}`
          : undefined,
      ),
    }];
  }

  if (part.type === "file" && part.file?.file_data) {
    const fileData = part.file.file_data;
    if (isAssetRef(fileData)) {
      return await resolveAssetRefPart(
        fileData,
        "file",
        support,
        store,
        part.file.mime_type,
        part.file.filename,
      );
    }
    if (fileData.startsWith("data:")) {
      return directDataPart(
        fileData,
        part.file.mime_type ?? dataUrlMime(fileData),
        support,
        part.file.filename,
      );
    }
    return [{
      type: "text",
      text: omittedFileText("unsupported_file_reference", part.file.mime_type),
    }];
  }

  return [];
}

export async function materializeAssetRefsForProvider(
  messages: ChatMessage[],
  config: AssetSupportConfig,
  store?: AssetStore,
): Promise<ChatMessage[]> {
  const hasMultimodalParts = messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part.type !== "text")
  );
  if (!hasMultimodalParts) return messages;

  const support = await resolveAssetSupport(config);
  const out: ChatMessage[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      out.push(message);
      continue;
    }

    const parts: ChatContentPart[] = [];
    for (const part of message.content) {
      const materialized = await materializePart(part, support, store);
      parts.push(...materialized.map((candidate): ChatContentPart => {
        if (
          part.type !== "text" &&
          part.tokenMetadata &&
          candidate.type !== "text" &&
          !candidate.tokenMetadata
        ) {
          return { ...candidate, tokenMetadata: part.tokenMetadata };
        }
        return candidate;
      }));
    }

    out.push({
      ...message,
      content: parts.length > 0 ? parts : "",
    });
  }

  return out;
}
