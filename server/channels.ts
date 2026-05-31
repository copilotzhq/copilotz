/**
 * Framework-independent channel helpers.
 *
 * These helpers wrap configured channel adapters into a single registry that
 * can resolve ingress and egress adapters for routes such as
 * `/channels/web/to/zendesk`.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import type { RunHandle, StreamEvent } from "@/runtime/index.ts";
import type { MessagePayload, Thread } from "@/types/index.ts";

/** Pair of ingress and egress channel names resolved from a route. */
export interface ChannelRouteSpec {
  ingress: string;
  egress: string;
}

/** Framework-independent request object passed into an ingress channel. */
export interface ChannelAdapterRequest {
  method: string;
  headers: Record<string, string>;
  query?: Record<string, unknown>;
  body: unknown;
  rawBody?: Uint8Array;
  callback?: (event: unknown) => void;
  context?: Record<string, unknown>;
  route: ChannelRouteSpec;
}

/** Normalized message envelope produced by an ingress adapter. */
export interface IngressEnvelope {
  message: MessagePayload;
  threadMetadataPatch?: unknown;
  /** Tenant/application namespace for this envelope. */
  namespace?: string;
  /** PostgreSQL schema for schema-isolated delivery. */
  schema?: string;
}

/** Result returned by an ingress adapter after request normalization. */
export interface IngressResult {
  messages?: IngressEnvelope[];
  status?: number;
  response?: unknown;
}

/** Adapter that converts an external channel request into Copilotz messages. */
export interface IngressAdapter {
  handle(
    request: ChannelAdapterRequest,
    copilotz: Copilotz,
  ): Promise<IngressResult>;
  detachedResponseStatus?: number;
}

/** Context provided to an egress adapter while delivering runtime output. */
export interface EgressDeliveryContext {
  route: ChannelRouteSpec;
  callback?: (event: unknown) => void;
  context?: Record<string, unknown>;
  handle: RunHandle;
  thread?: Thread;
  message: MessagePayload;
  copilotz: Copilotz;
  transformDeliveryOutput?: (output: unknown) => Promise<unknown | null>;
}

/** Adapter that delivers Copilotz output back to an external channel. */
export interface EgressAdapter {
  requestBound?: boolean;
  requiresCallback?: boolean;
  validateThreadContext?(
    thread: { metadata?: unknown } | undefined,
  ): void | Promise<void>;
  deliver(context: EgressDeliveryContext): Promise<void>;
}

/** Registered channel implementation and its optional ingress/egress sides. */
export interface ChannelEntry {
  name: string;
  ingress?: IngressAdapter;
  egress?: EgressAdapter;
}

type MaybePromise<T> = T | Promise<T>;

/** Input passed to channel override callbacks. */
export interface ChannelOverrideArgs<TInput, TOutput> {
  input: TInput;
  output: TOutput;
  channel: ChannelEntry;
  copilotz: Copilotz;
}

/** Callback used to transform or suppress channel ingress/egress output. */
export type ChannelOverrideCallback<TInput, TOutput> = (
  args: ChannelOverrideArgs<TInput, TOutput>,
) => MaybePromise<TOutput | null | void>;

/** Override hooks for an ingress adapter. */
export interface ChannelIngressOverrides {
  handle?: ChannelOverrideCallback<ChannelAdapterRequest, IngressResult>;
}

/** Override hooks for an egress adapter. */
export interface ChannelEgressOverrides {
  deliver?: ChannelOverrideCallback<EgressDeliveryContext, unknown>;
}

/** Override configuration for one channel entry. */
export interface ChannelOverridesEntry {
  ingress?: ChannelIngressOverrides;
  egress?: ChannelEgressOverrides;
}

/** Overrides keyed by channel name. */
export type ChannelOverrides = Record<
  string,
  ChannelOverridesEntry | undefined
>;

/** Handlers returned by {@link createChannelHandlers}. */
export interface ChannelHandlers {
  list: () => ChannelEntry[];
  get: (name: string) => ChannelEntry | undefined;
  getIngress: (name: string) => IngressAdapter | undefined;
  getEgress: (name: string) => EgressAdapter | undefined;
}

export function mergeChannelEntries(
  ...groups: Array<ChannelEntry[] | undefined>
): ChannelEntry[] {
  const channels = new Map<string, ChannelEntry>();

  for (const group of groups) {
    for (const entry of group ?? []) {
      if (typeof entry?.name !== "string" || entry.name.length === 0) continue;

      const existing = channels.get(entry.name);
      if (!existing) {
        channels.set(entry.name, { ...entry });
        continue;
      }

      channels.set(entry.name, {
        name: entry.name,
        ingress: existing.ingress ?? entry.ingress,
        egress: existing.egress ?? entry.egress,
      });
    }
  }

  return [...channels.values()];
}

/** Creates lookup handlers for configured Copilotz channel adapters. */
export function createChannelHandlers(copilotz: Copilotz): ChannelHandlers {
  const channels = mergeChannelEntries(
    (copilotz.config as { channels?: ChannelEntry[] }).channels,
  );
  const channelsByName = new Map(
    channels.map((channel) => [channel.name, channel] as const),
  );

  return {
    list: () => [...channelsByName.values()],
    get: (name) => channelsByName.get(name),
    getIngress: (name) => channelsByName.get(name)?.ingress,
    getEgress: (name) => channelsByName.get(name)?.egress,
  };
}

async function applyChannelOverride<TInput, TOutput>(
  override: ChannelOverrideCallback<TInput, TOutput> | undefined,
  args: ChannelOverrideArgs<TInput, TOutput>,
): Promise<TOutput | null> {
  if (!override) return args.output;
  const result = await override(args);
  return result === undefined ? args.output : result;
}

function swallowedIngressResult(output: IngressResult): IngressResult {
  return {
    status: output.status ?? 200,
    response: output.response ?? { status: "ok" },
    messages: [],
  };
}

function decorateChannelEntry(
  channel: ChannelEntry,
  overrides: ChannelOverridesEntry | undefined,
): ChannelEntry {
  if (!overrides) return channel;

  const decorated: ChannelEntry = { ...channel };

  if (channel.ingress && overrides.ingress?.handle) {
    const ingress = channel.ingress;
    decorated.ingress = {
      ...ingress,
      async handle(request, copilotz) {
        const output = await ingress.handle(request, copilotz);
        const overridden = await applyChannelOverride(
          overrides.ingress?.handle,
          {
            input: request,
            output,
            channel,
            copilotz,
          },
        );
        return overridden === null
          ? swallowedIngressResult(output)
          : overridden;
      },
    };
  }

  if (channel.egress && overrides.egress?.deliver) {
    const egress = channel.egress;
    decorated.egress = {
      ...egress,
      async deliver(context) {
        let transformed = false;
        const decoratedContext: EgressDeliveryContext = {
          ...context,
          async transformDeliveryOutput(output) {
            transformed = true;
            return await applyChannelOverride(overrides.egress?.deliver, {
              input: decoratedContext,
              output,
              channel,
              copilotz: context.copilotz,
            });
          },
        };
        await egress.deliver(decoratedContext);
        if (!transformed) {
          await applyChannelOverride(overrides.egress?.deliver, {
            input: decoratedContext,
            output: undefined,
            channel,
            copilotz: context.copilotz,
          });
        }
      },
    };
  }

  return decorated;
}

export async function transformEgressDeliveryOutput<T>(
  context: EgressDeliveryContext,
  output: T,
): Promise<T | null> {
  if (!context.transformDeliveryOutput) return output;
  const transformed = await context.transformDeliveryOutput(output);
  if (transformed === undefined) return output;
  if (transformed === null) return null;
  return transformed as T;
}

export function decorateChannelEntries(
  channels: ChannelEntry[] | undefined,
  overrides: ChannelOverrides | undefined,
): ChannelEntry[] | undefined {
  if (!channels?.length || !overrides) return channels;
  return channels.map((channel) =>
    decorateChannelEntry(channel, overrides[channel.name])
  );
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(",");
  const mime = parts[0].match(/:(.*?);/)?.[1] || "application/octet-stream";
  const bstr = atob(parts[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function splitString(
  input: string,
  maxLen: number,
  breakpoints: string[],
): string[] {
  const result: string[] = [];
  let idx = 0;

  while (idx < input.length) {
    if (idx + maxLen >= input.length) {
      result.push(input.substring(idx));
      break;
    }

    const end = idx + maxLen;
    let found = false;
    for (let i = end; i > idx; i--) {
      if (breakpoints.includes(input[i])) {
        result.push(input.substring(idx, i));
        idx = i + 1;
        found = true;
        break;
      }
    }
    if (!found) {
      result.push(input.substring(idx, end));
      idx = end;
    }
  }

  return result;
}

export async function verifyHmacSha256(
  body: Uint8Array,
  secret: string,
  signatureHeader: string,
): Promise<boolean> {
  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return false;

  const receivedHash = signatureHeader.slice(expectedPrefix.length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bodyBuffer = (body.buffer as ArrayBuffer).slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, bodyBuffer);
  const computedHash = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(receivedHash, computedHash);
}

export function toAsyncIterable(
  events: AsyncIterable<StreamEvent>,
): AsyncIterable<unknown> {
  return events as AsyncIterable<unknown>;
}

// ---- Built-in Channel Adapters -------------------------------------------

export { whatsappIngressAdapter } from "@/resources/channels/whatsapp/ingress.ts";
export { whatsappEgressAdapter } from "@/resources/channels/whatsapp/egress.ts";

export { zendeskIngressAdapter } from "@/resources/channels/zendesk/ingress.ts";
export { zendeskEgressAdapter } from "@/resources/channels/zendesk/egress.ts";

export { discordIngressAdapter } from "@/resources/channels/discord/ingress.ts";
export { discordEgressAdapter } from "@/resources/channels/discord/egress.ts";

export { telegramIngressAdapter } from "@/resources/channels/telegram/ingress.ts";
export { telegramEgressAdapter } from "@/resources/channels/telegram/egress.ts";
