import type { MessagePayload, ChatContext, Event } from "@/interfaces/index.ts";

import {
    base64ToBytes,
    parseDataUrl,
    isDataUrl,
    normalizeOutputToAssetRefs,
    extractAssetId,
    bytesToBase64,
} from "@/utils/assets.ts";

type AttachmentKind = "image" | "audio" | "file";

type RawAttachment = {
    kind: AttachmentKind;
    data?: string;
    dataUrl?: string;
    mimeType?: string;
    format?: string;
    fileName?: string;
    assetRef?: string;
};

type NormalizedAttachment = {
    kind: AttachmentKind;
    mimeType?: string;
    format?: string;
    fileName?: string;
    assetRef?: string;
    // For http(s) URLs we keep the original URL (not treated as an asset)
    dataUrl?: string;
};

type CreatedAssetInfo = { ref: string; mime?: string; kind?: AttachmentKind };

function extractAttachmentsFromContent(content: MessagePayload["content"]): RawAttachment[] {
    const attachments: RawAttachment[] = [];
    if (!Array.isArray(content)) return attachments;

    for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;

        const type = typeof p.type === "string" ? p.type : undefined;
        switch (type) {
            case "image": {
                const mimeType = typeof p.mimeType === "string" ? p.mimeType : undefined;
                if (typeof p.dataBase64 === "string") {
                    attachments.push({ kind: "image", data: p.dataBase64, mimeType });
                } else if (typeof p.url === "string") {
                    attachments.push({ kind: "image", dataUrl: p.url, mimeType });
                }
                break;
            }
            case "audio": {
                const mimeType = typeof p.mimeType === "string" ? p.mimeType : undefined;
                const format = typeof p.format === "string" ? p.format : undefined;
                if (typeof p.dataBase64 === "string") {
                    attachments.push({ kind: "audio", data: p.dataBase64, mimeType, format });
                } else if (typeof p.url === "string") {
                    attachments.push({ kind: "audio", dataUrl: p.url, mimeType, format });
                }
                break;
            }
            case "file": {
                const mimeType = typeof p.mimeType === "string" ? p.mimeType : undefined;
                const fileName = typeof p.name === "string" ? p.name : undefined;
                if (typeof p.dataBase64 === "string") {
                    attachments.push({ kind: "file", data: p.dataBase64, mimeType, fileName });
                } else if (typeof p.url === "string") {
                    attachments.push({ kind: "file", dataUrl: p.url, mimeType, fileName });
                }
                break;
            }
            default:
                break;
        }
    }

    return attachments;
}

async function normalizeAttachments(
    attachments: RawAttachment[],
    store?: { save: (bytes: Uint8Array, mime: string) => Promise<{ assetId: string }> },
): Promise<{ normalized: NormalizedAttachment[]; created: CreatedAssetInfo[] }> {
    if (!attachments.length) return { normalized: [], created: [] };

    const normalized: NormalizedAttachment[] = [];
    const created: CreatedAssetInfo[] = [];

    for (const att of attachments) {
        // Already an asset ref: keep as-is (but drop raw data)
        if (typeof att.assetRef === "string" && att.assetRef.startsWith("asset://")) {
            normalized.push({
                kind: att.kind,
                mimeType: att.mimeType,
                format: att.format,
                fileName: att.fileName,
                assetRef: att.assetRef,
            });
            continue;
        }

        // If we don't have a store, keep only lightweight info; avoid persisting large blobs when possible
        if (!store) {
            normalized.push({
                kind: att.kind,
                mimeType: att.mimeType,
                format: att.format,
                fileName: att.fileName,
                dataUrl: att.dataUrl && !isDataUrl(att.dataUrl) ? att.dataUrl : undefined,
            });
            continue;
        }

        let bytes: Uint8Array | null = null;
        let mime: string | undefined = att.mimeType;

        if (att.data && att.mimeType) {
            try {
                bytes = base64ToBytes(att.data);
            } catch {
                bytes = null;
            }
        } else if (att.dataUrl && isDataUrl(att.dataUrl)) {
            const parsed = parseDataUrl(att.dataUrl);
            if (parsed) {
                bytes = parsed.bytes;
                mime = parsed.mime;
            }
        }

        if (bytes && mime) {
            try {
                const { assetId } = await store.save(bytes, mime);
                const ref = `asset://${assetId}`;
                normalized.push({
                    kind: att.kind,
                    mimeType: mime,
                    format: att.format,
                    fileName: att.fileName,
                    assetRef: ref,
                });
                created.push({ ref, mime, kind: att.kind });
                continue;
            } catch {
                // fall through to non-asset path
            }
        }

        // Fallback: keep only lightweight info and non-data: URLs
        normalized.push({
            kind: att.kind,
            mimeType: att.mimeType,
            format: att.format,
            fileName: att.fileName,
            dataUrl: att.dataUrl && !isDataUrl(att.dataUrl) ? att.dataUrl : undefined,
        });
    }

    return { normalized, created };
}

export interface AssetProcessingResult {
    messageMetadata: Record<string, unknown> | null;
    toolCallMetadata: unknown[];
    contentOverride?: string;
}

export async function processAssetsForNewMessage(args: {
    payload: MessagePayload;
    baseMetadata: Record<string, unknown>;
    senderType: "agent" | "user" | "tool" | "system";
    context: ChatContext;
    event: Event;
    threadId: string;
}): Promise<AssetProcessingResult> {
    const { payload, baseMetadata, senderType, context, event, threadId } = args;

    const derivedAttachments = extractAttachmentsFromContent(payload.content);
    const existingRaw = (baseMetadata as { attachments?: unknown }).attachments;
    const existing = Array.isArray(existingRaw)
        ? (existingRaw as RawAttachment[])
        : [];

    const mergedAttachments = existing.concat(derivedAttachments);

    const store = context.assetStore;
    const { normalized: normalizedAttachments, created: createdFromAttachments } =
        await normalizeAttachments(mergedAttachments, store);

    // Normalize any toolCall outputs into asset refs as well
    const toolCallEntries = Array.isArray((baseMetadata as { toolCalls?: unknown[] }).toolCalls)
        ? ((baseMetadata as { toolCalls?: unknown[] }).toolCalls ?? [])
        : [];

    const createdFromToolOutputs: CreatedAssetInfo[] = [];

    if (toolCallEntries.length > 0 && store) {
        for (const entry of toolCallEntries) {
            if (!entry || typeof entry !== "object") continue;
            const maybeOutput = (entry as { output?: unknown }).output;
            if (typeof maybeOutput === "undefined") continue;
            try {
                const normalized = await normalizeOutputToAssetRefs(maybeOutput, store);
                (entry as { output?: unknown }).output = normalized.normalized;
                for (const c of normalized.created) {
                    createdFromToolOutputs.push({
                        ref: c.ref,
                        mime: c.mime,
                        kind: c.kind === "image" || c.kind === "audio" || c.kind === "file" ? c.kind : "file",
                    });
                }
            } catch {
                // ignore normalization errors, keep raw output
            }
        }
    }

    // Merge attachments from content and tool outputs
    const attachmentsFromToolOutputs: NormalizedAttachment[] = createdFromToolOutputs.map((c) => ({
        kind: (c.kind ?? "file") as AttachmentKind,
        mimeType: c.mime,
        assetRef: c.ref,
    }));

    const finalAttachments: NormalizedAttachment[] = normalizedAttachments.concat(attachmentsFromToolOutputs);

    const messageMetadata = {
        ...baseMetadata,
        ...(toolCallEntries.length ? { toolCalls: toolCallEntries } : {}),
        ...(finalAttachments.length ? { attachments: finalAttachments } : {}),
    } as Record<string, unknown> | null;

    const toolCallMetadata = Array.isArray((messageMetadata as { toolCalls?: unknown[] } | null)?.toolCalls)
        ? ((messageMetadata as { toolCalls?: unknown[] }).toolCalls ?? [])
        : [];

    let contentOverride: string | undefined = undefined;
    if (senderType === "tool" && toolCallMetadata.length > 0) {
        const outputs = toolCallMetadata
            .map((entry) => {
                if (entry && typeof entry === "object") {
                    return (entry as { output?: unknown }).output;
                }
                return undefined;
            })
            .filter((output): output is unknown => typeof output !== "undefined");

        if (outputs.length > 0) {
            const representative = outputs.length === 1 ? outputs[0] : outputs;
            if (typeof representative === "string") {
                contentOverride = representative;
            } else {
                try {
                    contentOverride = JSON.stringify(representative);
                } catch {
                    contentOverride = undefined;
                }
            }
        }
    }

    // Emit ASSET_CREATED events for any newly created assets (from content or tool outputs)
    const newlyCreatedRefs = new Set<string>();
    for (const c of createdFromAttachments) newlyCreatedRefs.add(c.ref);
    for (const c of createdFromToolOutputs) newlyCreatedRefs.add(c.ref);

    if (newlyCreatedRefs.size > 0 && context.callbacks?.onEvent && store) {
        for (const ref of newlyCreatedRefs) {
            try {
                const id = extractAssetId(ref);
                let base64: string | undefined = undefined;
                let mimeForEvent: string | undefined = undefined;
                let dataUrl: string | undefined = undefined;
                const { bytes, mime } = await store.get(id);
                mimeForEvent = mime;
                base64 = bytesToBase64(bytes);
                dataUrl = base64 ? `data:${mime};base64,${base64}` : undefined;

                const by =
                    senderType === "tool" ? "tool" :
                        senderType === "agent" ? "agent" :
                            senderType === "user" ? "user" : "system";

                const toolMeta = toolCallMetadata[0] && typeof toolCallMetadata[0] === "object"
                    ? (toolCallMetadata[0] as { id?: string; name?: string })
                    : undefined;

                await context.callbacks.onEvent({
                    id: crypto.randomUUID(),
                    threadId,
                    type: "ASSET_CREATED" as unknown as Event["type"],
                    payload: {
                        assetId: id,
                        ref,
                        ...(mimeForEvent ? { mime: mimeForEvent } : {}),
                        by,
                        ...(toolMeta?.name ? { tool: toolMeta.name } : {}),
                        ...(toolMeta?.id ? { toolCallId: toolMeta.id } : {}),
                        ...(base64 ? { base64 } : {}),
                        ...(dataUrl ? { dataUrl } : {}),
                    } as unknown as Event["payload"],
                    parentEventId: event.id as string,
                    traceId: event.traceId,
                    priority: null,
                    metadata: null,
                    ttlMs: null,
                    expiresAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    status: "completed",
                } as unknown as Event);
            } catch {
                // ignore ASSET_CREATED emission errors
            }
        }
    }

    return {
        messageMetadata,
        toolCallMetadata,
        contentOverride,
    };
}


