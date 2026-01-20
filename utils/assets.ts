// Asset primitives and a minimal in-memory AssetStore.
// Factory-first design, no classes.
// Focus: stable refs, base64/data URL helpers, and message ref resolution.

import type { ChatMessage, ChatContentPart } from "@/connectors/llm/types.ts";
import type { FsConnector } from "@/connectors/storage/fs.ts";
import { createFsConnector } from "@/connectors/storage/fs.ts";
import type { S3Connector } from "@/connectors/storage/s3.ts";

export type AssetId = string;
export type AssetRef = `asset://${string}`;

export interface AssetConfig {
	inlineThresholdBytes?: number;
	/**
	 * If false, do NOT resolve asset refs to data URLs for LLM calls.
	 * Messages will be sent as text-only (no multimodal parts).
	 * Default: true (resolve assets for providers).
	 */
	resolveInLLM?: boolean;
	/**
	 * Backend type: "memory" (default), "fs" (filesystem), "s3" (S3-compatible), or "passthrough".
	 * - "passthrough": Assets are extracted and ASSET_CREATED events are emitted, but data is NOT
	 *   persisted. Each asset can only be retrieved once (fire-once), then it's discarded.
	 *   Use this when you want to handle storage yourself via ASSET_CREATED events.
	 * When set, backend-specific configs must be provided.
	 */
	backend?: "memory" | "fs" | "s3" | "passthrough";
	/**
	 * Filesystem backend config (required if backend === "fs").
	 */
	fs?: Omit<FsAssetConfig, "inlineThresholdBytes" | "resolveInLLM">;
	/**
	 * S3 backend config (required if backend === "s3").
	 */
	s3?: Omit<S3AssetConfig, "inlineThresholdBytes" | "resolveInLLM">;
}

export interface AssetInfo {
	id: AssetId;
	mime: string;
	size: number;
	createdAt: Date;
}

export interface AssetStore {
	save(bytes: Uint8Array, mime: string): Promise<{ assetId: AssetId; info?: AssetInfo }>;
	get(assetId: AssetId): Promise<{ bytes: Uint8Array; mime: string }>;
	urlFor(assetId: AssetId, opts?: { inline?: boolean }): Promise<string>;
	info?(assetId: AssetId): Promise<AssetInfo | undefined>;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function isAssetRef(value: unknown): value is AssetRef {
	return typeof value === "string" && value.startsWith("asset://");
}

export function extractAssetId(ref: AssetRef | string): AssetId {
	return (ref.startsWith("asset://") ? ref.slice("asset://".length) : ref) as AssetId;
}

export function bytesToBase64(bytes: Uint8Array): string {
	// Deno / Web-safe base64 with chunking to avoid "Maximum call stack size exceeded"
	if (typeof btoa !== "function") return "";
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
	const bin = atob(base64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
	return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function isDataUrl(url: string): boolean {
	return typeof url === "string" && url.startsWith("data:");
}

export function parseDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
	if (!isDataUrl(url)) return null;
	try {
		const withoutPrefix = url.slice("data:".length);
		const [meta, b64] = withoutPrefix.split(",");
		const mime = meta?.split(";")[0] || "application/octet-stream";
		const bytes = base64ToBytes(b64 || "");
		return { mime, bytes };
	} catch {
		return null;
	}
}

function detectKindFromMime(mime: string): "image" | "audio" | "video" | "file" {
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("video/")) return "video";
	return "file";
}

// -----------------------------------------------------------------------------
// Memory Asset Store
// -----------------------------------------------------------------------------

export function createMemoryAssetStore(config: AssetConfig = {}): AssetStore {
	const inlineThreshold = Math.max(0, config.inlineThresholdBytes ?? 256_000);
	const byId = new Map<AssetId, { bytes: Uint8Array; mime: string; createdAt: Date }>();

	const save: AssetStore["save"] = (bytes, mime) => {
		if (!(bytes instanceof Uint8Array)) throw new Error("AssetStore.save: bytes must be Uint8Array");
		const m = typeof mime === "string" && mime.length > 0 ? mime : "application/octet-stream";
		const id = crypto.randomUUID();
		byId.set(id, { bytes, mime: m, createdAt: new Date() });
		return Promise.resolve({ assetId: id, info: { id, mime: m, size: bytes.byteLength, createdAt: new Date() } });
	};

	const get: AssetStore["get"] = (assetId) => {
		const rec = byId.get(assetId);
		if (!rec) throw new Error(`Asset not found: ${assetId}`);
		return Promise.resolve({ bytes: rec.bytes, mime: rec.mime });
	};

	const urlFor: AssetStore["urlFor"] = (assetId, opts) => {
		const rec = byId.get(assetId);
		if (!rec) throw new Error(`Asset not found: ${assetId}`);
		const inline = opts?.inline ?? (rec.bytes.byteLength <= inlineThreshold);
		if (inline) {
			return Promise.resolve(toDataUrl(rec.bytes, rec.mime));
		}
		// Memory backend has no external URL; fall back to data URL
		return Promise.resolve(toDataUrl(rec.bytes, rec.mime));
	};

	const info: NonNullable<AssetStore["info"]> = (assetId) => {
		const rec = byId.get(assetId);
		if (!rec) return Promise.resolve(undefined);
		return Promise.resolve({ id: assetId, mime: rec.mime, size: rec.bytes.byteLength, createdAt: rec.createdAt });
	};

	return { save, get, urlFor, info };
}

// -----------------------------------------------------------------------------
// Passthrough Asset Store (fire-once, no persistence)
// -----------------------------------------------------------------------------

/**
 * Creates a passthrough asset store that temporarily holds assets just long enough
 * for ASSET_CREATED events to be emitted, then discards them.
 * 
 * - `save()`: Stores in memory, returns assetId
 * - `get()`: Returns data and DELETES from memory (one-shot retrieval)
 * - `urlFor()`: Returns data URL if still present, else throws
 * - `info()`: Returns info if still present, else undefined
 * 
 * Use this when you want to receive ASSET_CREATED events with full base64/dataUrl
 * but handle persistence yourself (e.g., upload to your own CDN, S3, database).
 * 
 * Note: When using `backend: "passthrough"`, the framework automatically sets
 * `resolveInLLM: false` since assets are deleted after ASSET_CREATED emission.
 */
export function createPassthroughAssetStore(config: AssetConfig = {}): AssetStore {
	const byId = new Map<AssetId, { bytes: Uint8Array; mime: string; createdAt: Date }>();

	const save: AssetStore["save"] = (bytes, mime) => {
		if (!(bytes instanceof Uint8Array)) throw new Error("AssetStore.save: bytes must be Uint8Array");
		const m = typeof mime === "string" && mime.length > 0 ? mime : "application/octet-stream";
		const id = crypto.randomUUID();
		byId.set(id, { bytes, mime: m, createdAt: new Date() });
		return Promise.resolve({ assetId: id, info: { id, mime: m, size: bytes.byteLength, createdAt: new Date() } });
	};

	const get: AssetStore["get"] = (assetId) => {
		const rec = byId.get(assetId);
		if (!rec) throw new Error(`Asset not found (passthrough store - assets are fire-once): ${assetId}`);
		// Fire-once: delete after retrieval
		byId.delete(assetId);
		return Promise.resolve({ bytes: rec.bytes, mime: rec.mime });
	};

	const urlFor: AssetStore["urlFor"] = (assetId) => {
		const rec = byId.get(assetId);
		if (!rec) throw new Error(`Asset not found (passthrough store - assets are fire-once): ${assetId}`);
		// Don't delete here - urlFor might be called before get()
		return Promise.resolve(toDataUrl(rec.bytes, rec.mime));
	};

	const info: NonNullable<AssetStore["info"]> = (assetId) => {
		const rec = byId.get(assetId);
		if (!rec) return Promise.resolve(undefined);
		return Promise.resolve({ id: assetId, mime: rec.mime, size: rec.bytes.byteLength, createdAt: rec.createdAt });
	};

	return { save, get, urlFor, info };
}

// -----------------------------------------------------------------------------
// Filesystem Asset Store
// -----------------------------------------------------------------------------

export interface FsAssetConfig extends AssetConfig {
	rootDir: string;
	baseUrl?: string; // optional public/base URL
	connector?: FsConnector;
	prefix?: string; // optional subfolder under root
}

export function createFsAssetStore(config: FsAssetConfig): AssetStore {
	const rootDir = String(config.rootDir || ".").replace(/\/+$/, "");
	const baseUrl = typeof config.baseUrl === "string" && config.baseUrl.length > 0 ? config.baseUrl.replace(/\/+$/, "") : undefined;
	const prefix = typeof config.prefix === "string" && config.prefix.length > 0 ? config.prefix.replace(/^\/+|\/+$/g, "") : "";
	const fs = config.connector ?? createFsConnector(rootDir);

	const relPathFor = (id: string): string => {
		return prefix ? `${prefix}/${id}` : id;
	};

	const save: AssetStore["save"] = async (bytes, mime) => {
		const id = crypto.randomUUID();
		const rel = relPathFor(id);
		const path = fs.join(rel);
		await fs.writeFile(path, bytes);
		return { assetId: id, info: { id, mime, size: bytes.byteLength, createdAt: new Date() } };
	};

	const get: AssetStore["get"] = async (assetId) => {
		const rel = relPathFor(assetId);
		const path = fs.join(rel);
		const bytes = await fs.readFile(path);
		// No sidecar mime: default to octet-stream; callers can carry mime via metadata if needed
		const mime = "application/octet-stream";
		return { bytes, mime };
	};

	const urlFor: AssetStore["urlFor"] = async (assetId, opts) => {
		const rel = relPathFor(assetId);
		if (baseUrl) {
			return `${baseUrl}/${rel}`;
		}
		const { bytes, mime } = await get(assetId);
		const inline = opts?.inline ?? true;
		return inline ? toDataUrl(bytes, mime) : toDataUrl(bytes, mime);
	};

	const info: NonNullable<AssetStore["info"]> = async (assetId) => {
		const rel = relPathFor(assetId);
		const path = fs.join(rel);
		if (!(await fs.exists(path))) return undefined;
		const { bytes, mime } = await get(assetId);
		return { id: assetId, mime, size: bytes.byteLength, createdAt: new Date() };
	};

	return { save, get, urlFor, info };
}

// -----------------------------------------------------------------------------
// S3/MinIO Asset Store
// -----------------------------------------------------------------------------

export interface S3AssetConfig extends AssetConfig {
	bucket: string;
	connector: S3Connector; // bring your own connector (or use createS3Connector from connectors)
	publicBaseUrl?: string; // optional public endpoint for GETs
	keyPrefix?: string; // optional key prefix within bucket
}

export function createS3AssetStore(config: S3AssetConfig): AssetStore {
	const bucket = config.bucket;
	const s3 = config.connector;
	const publicBaseUrl = typeof config.publicBaseUrl === "string" && config.publicBaseUrl.length > 0 ? config.publicBaseUrl.replace(/\/+$/, "") : undefined;
	const keyPrefix = typeof config.keyPrefix === "string" && config.keyPrefix.length > 0 ? config.keyPrefix.replace(/^\/+|\/+$/g, "") : "";

	const keyFor = (id: string): string => (keyPrefix ? `${keyPrefix}/${id}` : id);

	const save: AssetStore["save"] = async (bytes, mime) => {
		const id = crypto.randomUUID();
		const key = keyFor(id);
		await s3.putObject({ bucket, key, body: bytes, contentType: mime });
		return { assetId: id, info: { id, mime, size: bytes.byteLength, createdAt: new Date() } };
	};

	const get: AssetStore["get"] = async (assetId) => {
		const key = keyFor(assetId);
		const obj = await s3.getObject({ bucket, key });
		const mime = obj.contentType || "application/octet-stream";
		return { bytes: obj.body, mime };
	};

	const urlFor: AssetStore["urlFor"] = async (assetId, opts) => {
		const key = keyFor(assetId);
		// Prefer explicit public URL
		if (typeof s3.publicUrl === "function") {
			return s3.publicUrl(bucket, key);
		}
		if (publicBaseUrl) {
			return `${publicBaseUrl}/${key}`;
		}
		// Next, try signed URL if available
		if (typeof s3.getSignedUrl === "function") {
			return await s3.getSignedUrl(bucket, key, { method: "GET", expiresIn: 300 });
		}
		// Fallback to inline data URL (will cost memory/tokens)
		const { bytes, mime } = await get(assetId);
		const inline = opts?.inline ?? true;
		return inline ? toDataUrl(bytes, mime) : toDataUrl(bytes, mime);
	};

	const info: NonNullable<AssetStore["info"]> = async (assetId) => {
		try {
			const { bytes, mime } = await get(assetId);
			return { id: assetId, mime, size: bytes.byteLength, createdAt: new Date() };
		} catch {
			return undefined;
		}
	};

	return { save, get, urlFor, info };
}

// -----------------------------------------------------------------------------
// Asset Store Factory (dispatches by backend)
// -----------------------------------------------------------------------------

export function createAssetStore(config: AssetConfig = {}): AssetStore {
	const backend = config.backend ?? "memory";
	const common = {
		inlineThresholdBytes: config.inlineThresholdBytes,
		resolveInLLM: config.resolveInLLM,
	};

	if (backend === "passthrough") {
		return createPassthroughAssetStore(common);
	}

	if (backend === "fs") {
		if (!config.fs) {
			throw new Error("AssetConfig.backend='fs' requires AssetConfig.fs to be provided");
		}
		return createFsAssetStore({ ...common, ...config.fs });
	}

	if (backend === "s3") {
		if (!config.s3) {
			throw new Error("AssetConfig.backend='s3' requires AssetConfig.s3 to be provided");
		}
		return createS3AssetStore({ ...common, ...config.s3 });
	}

	// Default: memory
	return createMemoryAssetStore(common);
}

// -----------------------------------------------------------------------------
// Message Asset Ref Resolution
// -----------------------------------------------------------------------------

export type ResolveResult = { messages: ChatMessage[]; referenced: AssetRef[] };

export async function resolveAssetRefsInMessages(
	messages: ChatMessage[],
	store?: AssetStore,
): Promise<ResolveResult> {
	if (!store) return { messages, referenced: [] };

	const referenced = new Set<AssetRef>();
	const clone = JSON.parse(JSON.stringify(messages)) as ChatMessage[];

	// Returns null to signal the part should be filtered out
	const resolvePart = async (part: ChatContentPart): Promise<ChatContentPart | null> => {
		// Filter out text placeholders like [asset:...] - they're redundant with multimodal parts
		if (part.type === "text") {
			const text = (part.text ?? "").trim();
			if (/^\[asset:[^\]]+\]$/.test(text)) {
				return null; // Remove this placeholder
			}
			return part;
		}
		if (part.type === "image_url") {
			const url = part.image_url?.url;
			if (typeof url === "string" && isAssetRef(url)) {
				const id = extractAssetId(url);
				const dataUrl = await store.urlFor(id, { inline: true });
				referenced.add(url as AssetRef);
				return { type: "image_url", image_url: { url: dataUrl } };
			}
			return part;
		}
		if (part.type === "file") {
			const fileData = part.file?.file_data;
			if (typeof fileData === "string" && isAssetRef(fileData)) {
				const id = extractAssetId(fileData);
				const { bytes, mime } = await store.get(id);
				const dataUrl = toDataUrl(bytes, mime);
				referenced.add(fileData as AssetRef);
				return { type: "file", file: { file_data: dataUrl, mime_type: mime } };
			}
			return part;
		}
		if (part.type === "input_audio") {
			const dataVal = part.input_audio?.data;
			if (typeof dataVal === "string" && isAssetRef(dataVal)) {
				const id = extractAssetId(dataVal);
				const { bytes, mime } = await store.get(id);
				const format = mime.includes("/") ? mime.split("/")[1] : part.input_audio.format;
				referenced.add(dataVal as AssetRef);
				return { type: "input_audio", input_audio: { data: bytesToBase64(bytes), ...(format ? { format } : {}) } };
			}
			return part;
		}
		return part;
	};

	const out: ChatMessage[] = [];
	for (const m of clone) {
		if (Array.isArray(m.content)) {
			const resolvedParts: ChatContentPart[] = [];
			for (const p of m.content) {
				const resolved = await resolvePart(p);
				if (resolved !== null) {
					resolvedParts.push(resolved);
				}
			}
			// If only one text part remains, flatten to string
			if (resolvedParts.length === 1 && resolvedParts[0].type === "text") {
				out.push({ ...m, content: (resolvedParts[0] as { text?: string }).text ?? "" });
			} else {
				out.push({ ...m, content: resolvedParts.length > 0 ? resolvedParts : "" });
			}
		} else {
			out.push(m);
		}
	}

	return { messages: out, referenced: Array.from(referenced) };
}

// -----------------------------------------------------------------------------
// Output Normalization (tools/LLMs -> AssetRef)
// -----------------------------------------------------------------------------

export type DetectedAsset = {
	bytes: Uint8Array;
	mime: string;
	kind: "image" | "audio" | "video" | "file";
};

export function detectAssetFromValue(value: unknown): DetectedAsset | null {
	// Pattern 1: { mimeType, dataBase64 }
	if (value && typeof value === "object") {
		const v = value as Record<string, unknown>;
		if (typeof v.mimeType === "string" && typeof v.dataBase64 === "string") {
			const bytes = base64ToBytes(v.dataBase64);
			const mime = v.mimeType;
			return { bytes, mime, kind: detectKindFromMime(mime) };
		}
		if (typeof v.dataUrl === "string" && isDataUrl(v.dataUrl)) {
			const parsed = parseDataUrl(v.dataUrl);
			if (parsed) {
				return { bytes: parsed.bytes, mime: parsed.mime, kind: detectKindFromMime(parsed.mime) };
			}
		}
	}
	// Pattern 2: direct data URL string
	if (typeof value === "string" && isDataUrl(value)) {
		const parsed = parseDataUrl(value);
		if (parsed) {
			return { bytes: parsed.bytes, mime: parsed.mime, kind: detectKindFromMime(parsed.mime) };
		}
	}
	return null;
}

export async function normalizeOutputToAssetRefs(value: unknown, store?: AssetStore): Promise<{ normalized: unknown; created: Array<{ ref: AssetRef; mime: string; kind: DetectedAsset["kind"] }> }> {
	if (!store) return { normalized: value, created: [] };

	const created: Array<{ ref: AssetRef; mime: string; kind: DetectedAsset["kind"] }> = [];

	const visit = async (node: unknown): Promise<unknown> => {
		const single = detectAssetFromValue(node);
		if (single) {
			const { assetId } = await store.save(single.bytes, single.mime);
			const ref = (`asset://${assetId}`) as AssetRef;
			created.push({ ref, mime: single.mime, kind: single.kind });
			// Replace with a compact ref object
			return { assetRef: ref, mimeType: single.mime, kind: single.kind };
		}

		if (Array.isArray(node)) {
			const out = [];
			for (const item of node) out.push(await visit(item));
			return out;
		}
		if (node && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
				out[k] = await visit(v);
			}
			return out;
		}
		return node;
	};

	const normalized = await visit(value);
	return { normalized, created };
}

// -----------------------------------------------------------------------------
// Convenience resolvers
// -----------------------------------------------------------------------------

export async function getBase64ForRef(store: AssetStore, refOrId: string): Promise<{ base64: string; mime: string }> {
	const id = refOrId.startsWith("asset://") ? refOrId.slice("asset://".length) : refOrId;
	const { bytes, mime } = await store.get(id);
	return { base64: bytesToBase64(bytes), mime };
}

export async function getDataUrlForRef(store: AssetStore, refOrId: string): Promise<string> {
	const id = refOrId.startsWith("asset://") ? refOrId.slice("asset://".length) : refOrId;
	const { bytes, mime } = await store.get(id);
	return toDataUrl(bytes, mime);
}

export function findAssetRefs(value: unknown): AssetRef[] {
	const out = new Set<AssetRef>();
	const visit = (node: unknown) => {
		if (typeof node === "string" && isAssetRef(node)) {
			out.add(node as AssetRef);
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (node && typeof node === "object") {
			for (const v of Object.values(node as Record<string, unknown>)) visit(v);
		}
	};
	visit(value);
	return Array.from(out);
}


