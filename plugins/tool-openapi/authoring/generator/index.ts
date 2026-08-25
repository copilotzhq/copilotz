/**
 * Generates immutable Tool Resources and executable Actions from OpenAPI
 * declarations at composition time.
 *
 * @module
 */

import type {
  API,
  APIPrepareRequestContext,
  APIPrepareRequestInput,
  APIResponseAssetMapping,
  APIResponseAssetMappings,
} from "../../../tools/authoring/integration-resources/index.ts";
import {
  assetIdFromRef,
  base64ToBytes,
  type ContentRef,
  parseDataUrl,
} from "@copilotz/copilotz/content";
import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";
import { parse as parseYaml } from "../../../../dependencies/yaml.ts";
import { defineTool } from "../../../tools/authoring/define-tool/index.ts";
import { cloneLosslessJson } from "../../../tools/authoring/internal/lifecycle-json.ts";
import {
  assertGeneratedEntryUnique,
  generatedActionAlias,
  generatedActionIdSegment,
} from "../../../tools/authoring/internal/generated.ts";
import {
  composeOpenApiToolsPlugin,
  type OpenApiGeneratedTool,
  type OpenApiToolsPlugin,
} from "../../plugin.ts";

class ToolExecutionError extends Error {
  readonly response: unknown;
  readonly status: number;

  constructor(response: unknown, status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "ToolExecutionError";
    this.response = response;
    this.status = status;
  }
}

type AuthConfig = NonNullable<API["auth"]>;
type DynamicAuth = Extract<AuthConfig, { type: "dynamic" }>;

// Token cache for dynamic authentication
interface CachedToken {
  token: string;
  expiry: number;
  refreshToken?: string;
}

function actionAbortError(signal: AbortSignal): DOMException {
  if (
    signal.reason instanceof DOMException && signal.reason.name === "AbortError"
  ) {
    return signal.reason;
  }
  return new DOMException(
    signal.reason instanceof Error ? signal.reason.message : "Action cancelled",
    "AbortError",
  );
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: any[];
  requestBody?: any;
  responses?: any;
}

interface OpenAPIPath {
  [method: string]: OpenAPIOperation;
}

interface OpenAPISchema {
  openapi: string;
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, OpenAPIPath>;
  components?: {
    schemas?: Record<string, any>;
    parameters?: Record<string, any>;
    requestBodies?: Record<string, any>;
  };
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Asset-producing API response must be an object.");
  }
  return value as Record<string, unknown>;
}

function responseField(
  response: Record<string, unknown>,
  field: string,
  name: string,
): string {
  const value = response[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(
      `Asset-producing API response requires ${name} field '${field}'.`,
    );
  }
  return value;
}

const DEFAULT_RESPONSE_ASSET_MAX_BYTES = 20 * 1024 * 1024;

type ResponseAssetCandidate = Readonly<{
  mappingIndex: number;
  sourceField: string;
  outputField: string;
  mediaType: string;
  bytes: Uint8Array;
  name?: string;
}>;

function responseAssetMappings(
  configured: APIResponseAssetMappings,
): readonly APIResponseAssetMapping[] {
  const mappings = Array.isArray(configured) ? configured : [configured];
  if (mappings.length === 0) {
    throw new TypeError("Response asset mappings cannot be empty.");
  }
  return mappings as readonly APIResponseAssetMapping[];
}

function responseAssetSource(
  response: Record<string, unknown>,
  mapping: APIResponseAssetMapping,
): Readonly<{ field: string; mediaType: string; bytes: Uint8Array }> | null {
  const dataUrlMapping = "dataUrlField" in mapping &&
    typeof mapping.dataUrlField === "string";
  const base64Mapping = "dataBase64Field" in mapping &&
    typeof mapping.dataBase64Field === "string";
  if (dataUrlMapping === base64Mapping) {
    throw new TypeError(
      "Response asset mapping requires exactly one dataUrlField or dataBase64Field.",
    );
  }

  const field = dataUrlMapping ? mapping.dataUrlField : mapping.dataBase64Field;
  const raw = response[field];
  if ((raw === undefined || raw === null) && mapping.optional) return null;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new TypeError(
      `Asset-producing API response requires asset data field '${field}'.`,
    );
  }

  if (dataUrlMapping) {
    const parsed = parseDataUrl(raw);
    if (!parsed) {
      throw new TypeError(
        `Asset-producing API response field '${field}' is not a valid data URL.`,
      );
    }
    return Object.freeze({ field, ...parsed });
  }

  const mediaType = responseField(
    response,
    mapping.mediaTypeField,
    "media type",
  );
  try {
    return Object.freeze({
      field,
      mediaType,
      bytes: base64ToBytes(raw),
    });
  } catch {
    throw new TypeError(
      `Asset-producing API response field '${field}' is not valid base64.`,
    );
  }
}

function validateResponseAsset(
  source: Readonly<{ mediaType: string; bytes: Uint8Array }>,
  mapping: APIResponseAssetMapping,
): void {
  const mediaTypes = mapping.mediaTypes;
  if (mediaTypes !== undefined) {
    if (
      !Array.isArray(mediaTypes) || mediaTypes.length === 0 ||
      mediaTypes.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw new TypeError(
        "Response asset mediaTypes must be non-empty strings.",
      );
    }
    const mediaType = source.mediaType.toLowerCase();
    const allowed = mediaTypes.some((value) => {
      const expected = value.trim().toLowerCase();
      return expected.endsWith("/*")
        ? mediaType.startsWith(expected.slice(0, -1))
        : mediaType === expected;
    });
    if (!allowed) {
      throw new TypeError(
        `Response asset media type '${source.mediaType}' is not allowed.`,
      );
    }
  }

  const maxBytes = mapping.maxBytes ?? DEFAULT_RESPONSE_ASSET_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(
      "Response asset maxBytes must be a positive safe integer.",
    );
  }
  if (source.bytes.byteLength > maxBytes) {
    throw new TypeError(
      `Response asset exceeds the configured ${maxBytes}-byte limit.`,
    );
  }
}

function attachmentKind(
  mediaType: string,
): "image" | "audio" | "video" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

function attachmentName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

async function promoteResponseAssets(
  value: unknown,
  configured: APIResponseAssetMappings,
  context: ActionContext,
  actionAlias: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = responseRecord(value);
  const mappings = responseAssetMappings(configured);
  const output: Record<string, unknown> = { ...response };
  const outputFields = new Set<string>();
  const candidates: ResponseAssetCandidate[] = [];

  for (const [index, mapping] of mappings.entries()) {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new TypeError("Response asset mapping must be an object.");
    }
    const source = responseAssetSource(response, mapping);
    if (!source) continue;
    validateResponseAsset(source, mapping);
    const outputField = mapping.outputField?.trim() ||
      (mappings.length === 1 ? "asset" : `${source.field}Asset`);
    if (!outputField || outputFields.has(outputField)) {
      throw new TypeError(
        `Response asset output field '${outputField}' must be unique.`,
      );
    }
    if (
      outputField !== source.field && Object.hasOwn(response, outputField)
    ) {
      throw new TypeError(
        `Response asset output field '${outputField}' would overwrite response data.`,
      );
    }
    outputFields.add(outputField);
    const nameValue = mapping.nameField
      ? responseField(response, mapping.nameField, "name")
      : undefined;
    candidates.push(Object.freeze({
      mappingIndex: index,
      sourceField: source.field,
      outputField,
      mediaType: source.mediaType,
      bytes: source.bytes,
      ...(nameValue ? { name: attachmentName(nameValue) } : {}),
    }));
    delete output[source.field];
  }

  for (const candidate of candidates) {
    const asset = await context.content.publish({
      body: candidate.bytes,
      mediaType: candidate.mediaType,
      ...(candidate.name ? { metadata: { name: candidate.name } } : {}),
    }, {
      operationKey: mappings.length === 1
        ? `openapi:${actionAlias}:response-asset`
        : `openapi:${actionAlias}:response-asset:${candidate.mappingIndex}:${candidate.outputField}`,
    });
    const ref: ContentRef = Object.freeze({
      assetId: asset.id,
      kind: attachmentKind(candidate.mediaType),
      role: "attachment",
      mediaType: candidate.mediaType,
      disposition: "attachment",
      ...(candidate.name ? { name: candidate.name } : {}),
    });
    output[candidate.outputField] = ref;
  }
  return Object.freeze(output);
}

/**
 * Converts OpenAPI parameter schema to JSON Schema for tool validation
 * Also returns metadata about where each parameter should be routed
 */
function convertParameterToJsonSchema(
  parameters: any[] = [],
  requestBody?: any,
): {
  schema: any;
  parameterMetadata: {
    pathParams: Set<string>;
    queryParams: Set<string>;
    bodyParams: Set<string>;
    isObjectBody: boolean;
  };
} {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  const pathParams = new Set<string>();
  const queryParams = new Set<string>();
  const bodyParams = new Set<string>();
  let isObjectBody = false;
  let additionalProperties: unknown = undefined;

  // Process path, query, and header parameters
  parameters.forEach((param) => {
    if (param.name && param.schema) {
      const description = param.description || param.schema.description;
      properties[param.name] = {
        ...param.schema,
        ...(description !== undefined ? { description } : {}),
      };

      if (param.required) {
        required.push(param.name);
      }

      // Track parameter location
      if (param.in === "path") {
        pathParams.add(param.name);
      } else if (param.in === "query") {
        queryParams.add(param.name);
      }
      // Note: headers are handled in authentication, so we skip them here
    }
  });

  // Process request body if it exists
  if (requestBody?.content) {
    const jsonContent = requestBody.content["application/json"];
    if (jsonContent?.schema) {
      // If it's an object schema, merge properties and mark them as body params
      if (
        jsonContent.schema.type === "object" && jsonContent.schema.properties
      ) {
        isObjectBody = true;
        additionalProperties = jsonContent.schema.additionalProperties;
        Object.keys(jsonContent.schema.properties).forEach((propName) => {
          properties[propName] = jsonContent.schema.properties[propName];
          bodyParams.add(propName);
        });
        if (jsonContent.schema.required) {
          required.push(...jsonContent.schema.required);
        }
      } else {
        // For non-object schemas, create a 'body' parameter
        properties.body = jsonContent.schema;
        bodyParams.add("body");
        if (requestBody.required) {
          required.push("body");
        }
      }
    }
  }

  return {
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(additionalProperties !== undefined ? { additionalProperties } : {}),
    },
    parameterMetadata: {
      pathParams,
      queryParams,
      bodyParams,
      isObjectBody,
    },
  };
}

/**
 * Detects if a string is JSON or YAML format
 */
function detectFormat(input: string): "json" | "yaml" {
  // Trim whitespace for better detection
  const trimmed = input.trim();

  // JSON typically starts with { or [
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }

  // YAML often has key: value patterns without quotes
  // or starts with --- (document separator)
  if (
    trimmed.startsWith("---") ||
    /^[a-zA-Z_][a-zA-Z0-9_]*:\s/.test(trimmed) ||
    /^openapi:\s*['"]?3\./.test(trimmed)
  ) {
    return "yaml";
  }

  // Default to JSON and let parsing errors handle invalid format
  return "json";
}

/**
 * Normalizes OpenAPI schema to ensure consistent structure
 * Supports both JSON and YAML string inputs, as well as parsed objects
 */
function normalizeOpenApiSchema(schema: any): OpenAPISchema {
  // If it's already an object, return as-is
  if (typeof schema === "object" && schema !== null) {
    return schema as OpenAPISchema;
  }

  // If it's a string, detect format and parse accordingly
  if (typeof schema === "string") {
    const format = detectFormat(schema);

    try {
      if (format === "json") {
        schema = JSON.parse(schema);
      } else {
        // YAML format - parseYaml can also handle JSON
        schema = parseYaml(schema);
      }
    } catch (error) {
      console.error(
        `Failed to parse ${format.toUpperCase()} OpenAPI schema:`,
        error,
      );
      throw new Error(
        `Invalid ${format.toUpperCase()} OpenAPI schema provided. ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  // Validate that it's a valid OpenAPI 3.x schema
  if (!schema.openapi || !schema.openapi.startsWith("3.")) {
    console.warn(
      "Provided schema does not appear to be OpenAPI 3.x format. Some features might not work as expected.",
    );
  }

  // Ensure required fields exist
  if (!schema.paths) {
    throw new Error("OpenAPI schema must contain a 'paths' object");
  }

  return schema as OpenAPISchema;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const NULL_CHAR_PATTERN = /\u0000/g;

function sanitizeToolJsonValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") {
    return value.replace(NULL_CHAR_PATTERN, "") as T;
  }

  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[Circular]" as T;
  seen.add(value);

  if (Array.isArray(value)) {
    const next = value.map((item) => sanitizeToolJsonValue(item, seen)) as T;
    seen.delete(value);
    return next;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    next[key] = sanitizeToolJsonValue(child, seen);
  }
  seen.delete(value);
  return next as T;
}

type NdjsonRecord = Readonly<{
  type: "output" | "result" | "error";
  channel?: string;
  mode?: "append";
  mediaType?: string;
  delta?: unknown;
  value?: unknown;
  error?: unknown;
}>;

function ndjsonRecord(value: unknown): NdjsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("NDJSON tool response records must be objects.");
  }
  const record = sanitizeToolJsonValue(value) as Record<string, unknown>;
  if (record.type === "output") {
    if (typeof record.channel !== "string" || !record.channel.trim()) {
      throw new TypeError("NDJSON tool output requires a channel.");
    }
    if (record.mode === "replace") {
      throw new TypeError(
        "NDJSON tool output mode 'replace' is unsupported; use append records.",
      );
    }
    if (record.mode !== undefined && record.mode !== "append") {
      throw new TypeError("NDJSON tool output mode must be append.");
    }
    return record as NdjsonRecord;
  }
  if (record.type === "result" || record.type === "error") {
    return record as NdjsonRecord;
  }
  throw new TypeError("NDJSON tool response record type is invalid.");
}

async function consumeNdjsonToolResponse(
  response: Response,
  context: ActionContext,
): Promise<unknown> {
  if (!response.body) throw new TypeError("NDJSON tool response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  type Writer = Awaited<ReturnType<ActionContext["streams"]["open"]>>;
  const channels = new Map<string, {
    writer: Writer;
    mediaType: string;
    appendIndex: number;
    settled: boolean;
  }>();
  const streamIds = new Map<string, string>();
  let buffered = "";
  let terminal: NdjsonRecord | undefined;
  const processLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line) return;
    const record = ndjsonRecord(JSON.parse(line));
    if (terminal) {
      throw new TypeError("NDJSON tool response emitted after settlement.");
    }
    if (record.type === "output") {
      const channel = record.channel!.trim();
      const declaredMediaType = typeof record.mediaType === "string" &&
          record.mediaType.trim()
        ? record.mediaType.trim()
        : undefined;
      let state = channels.get(channel);
      if (!state) {
        const streamIdSegment = generatedActionAlias(channel, "channel");
        const collidingChannel = streamIds.get(streamIdSegment);
        if (collidingChannel && collidingChannel !== channel) {
          throw new TypeError(
            `NDJSON channels '${collidingChannel}' and '${channel}' produce the same stream ID.`,
          );
        }
        const mediaType = declaredMediaType ?? "text/plain";
        const writer = await context.streams.open({
          id: `${context.action.runId}:${streamIdSegment}`,
          mediaType,
          role: "tool.output",
          metadata: { channel },
          correlationId: context.identity.correlationId,
        }, { signal: context.signal });
        state = { writer, mediaType, appendIndex: 0, settled: false };
        channels.set(channel, state);
        streamIds.set(streamIdSegment, channel);
      } else if (
        declaredMediaType !== undefined && declaredMediaType !== state.mediaType
      ) {
        throw new TypeError(
          `NDJSON channel '${channel}' changed mediaType from '${state.mediaType}' to '${declaredMediaType}'.`,
        );
      }
      const value = typeof record.delta === "string"
        ? record.delta
        : `${JSON.stringify(record.delta ?? null)}\n`;
      await state.writer.append({
        bytes: encoder.encode(value),
        appendId: `${context.action.runId}:${channel}:${state.appendIndex++}`,
      }, { signal: context.signal });
      return;
    }
    terminal = record;
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      let boundary = buffered.indexOf("\n");
      while (boundary >= 0) {
        await processLine(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary + 1);
        boundary = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    await processLine(buffered);
    if (!terminal) {
      throw new TypeError("NDJSON tool response ended without a result.");
    }
    if (terminal.type === "error") {
      throw new ToolExecutionError(
        terminal.error ?? terminal.value,
        response.status,
        response.statusText || "Stream failed",
      );
    }
    const closed: Array<
      Readonly<{
        channel: string;
        prepared: Awaited<ReturnType<Writer["close"]>>;
      }>
    > = [];
    for (const [channel, state] of channels) {
      const prepared = await state.writer.close({
        assetId: `${context.action.runId}:${
          generatedActionAlias(channel, "channel")
        }`,
        metadata: { channel },
      }, { signal: context.signal });
      state.settled = true;
      closed.push({ channel, prepared });
    }
    for (const { channel, prepared } of closed) {
      if (prepared.content.length !== 1) {
        throw new TypeError(
          `NDJSON channel '${channel}' must close with exactly one ContentRef.`,
        );
      }
    }
    const combined = Object.freeze({
      content: Object.freeze(closed.map(({ prepared }) => prepared.content[0])),
      assets: Object.freeze(closed.flatMap(({ prepared }) => prepared.assets)),
    });
    const materialized = closed.length > 0
      ? await context.content.materialize(combined)
      : [];
    if (materialized.length !== closed.length) {
      throw new TypeError(
        "NDJSON content materialization must return one ContentRef per channel.",
      );
    }
    const streams: Record<string, ContentRef> = {};
    closed.forEach(({ channel, prepared }, index) => {
      const ref = materialized[index];
      if (ref.assetId !== prepared.content[0].assetId) {
        throw new TypeError(
          `NDJSON channel '${channel}' materialized an unexpected ContentRef.`,
        );
      }
      streams[channel] = ref;
    });
    if (Object.keys(streams).length === 0) return terminal.value;
    const value = terminal.value;
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.freeze({
        ...(value as Record<string, unknown>),
        streams: Object.freeze(streams),
      })
      : Object.freeze({ value, streams: Object.freeze(streams) });
  } catch (error) {
    await Promise.allSettled(
      [...channels.values()]
        .filter((state) => !state.settled)
        .map(async (state) => {
          await state.writer.abort({
            reason: error instanceof Error ? error.message : String(error),
          });
          state.settled = true;
        }),
    );
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(
      `Unsupported OpenAPI reference "${ref}". Only local references beginning with "#/" are supported.`,
    );
  }

  return ref.slice(2).split("/").reduce((current, rawSegment) => {
    if (current === undefined || current === null) return undefined;
    const segment = decodeJsonPointerSegment(rawSegment);
    return (current as Record<string, unknown>)[segment];
  }, root);
}

function dereferenceOpenApiLocalRefs<T>(
  value: T,
  root: unknown = value,
  seenRefs = new Set<string>(),
): T {
  if (Array.isArray(value)) {
    return value.map((item) =>
      dereferenceOpenApiLocalRefs(item, root, seenRefs)
    ) as T;
  }

  if (!value || typeof value !== "object") return value;

  const objectValue = value as Record<string, unknown>;
  if (typeof objectValue.$ref === "string") {
    const ref = objectValue.$ref;
    if (seenRefs.has(ref)) {
      throw new Error(`Circular OpenAPI reference detected: ${ref}`);
    }

    const resolved = resolveLocalJsonPointer(root, ref);
    if (resolved === undefined) {
      throw new Error(`Unable to resolve OpenAPI reference: ${ref}`);
    }

    const nextSeenRefs = new Set(seenRefs);
    nextSeenRefs.add(ref);
    const { $ref: _ref, ...overrides } = objectValue;
    return dereferenceOpenApiLocalRefs(
      {
        ...cloneJson(resolved),
        ...overrides,
      },
      root,
      nextSeenRefs,
    ) as T;
  }

  const dereferenced: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(objectValue)) {
    dereferenced[key] = dereferenceOpenApiLocalRefs(child, root, seenRefs);
  }
  return dereferenced as T;
}

/**
 * Extracts value from object using JSONPath-like string
 */
function extractValue(obj: any, path: string): any {
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

/**
 * Calls authentication endpoint and returns token
 */
async function callAuthEndpoint(
  authConfig: DynamicAuth,
  baseUrl: string,
  signal: AbortSignal,
): Promise<CachedToken> {
  const authUrl = authConfig.authEndpoint.url.startsWith("http")
    ? authConfig.authEndpoint.url
    : baseUrl + authConfig.authEndpoint.url;

  const method = authConfig.authEndpoint.method || "POST";
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Copilotz-Agents/1.0",
    ...authConfig.authEndpoint.headers,
  };

  let body: string | undefined;
  if (method !== "GET") {
    body = JSON.stringify(
      authConfig.authEndpoint.body || authConfig.authEndpoint.credentials || {},
    );
  }

  const response = await fetch(authUrl, { method, headers, body, signal });

  if (!response.ok) {
    throw new Error(
      `Authentication failed: ${response.status} ${response.statusText}`,
    );
  }

  const authResponse = authConfig.tokenExtraction.path
    ? await response.json()
    : undefined;
  const token = authConfig.tokenExtraction.path
    ? extractValue(authResponse, authConfig.tokenExtraction.path)
    : (await response.text()).trim();

  if (!token) {
    throw new Error(
      authConfig.tokenExtraction.path
        ? `Token not found at path: ${authConfig.tokenExtraction.path}`
        : "Token not found in response body",
    );
  }

  // Calculate expiry
  let expiry = Date.now() + (authConfig.cache?.duration || 3600) * 1000;
  if (authResponse && authConfig.refreshConfig?.expiryPath) {
    const expiryValue = extractValue(
      authResponse,
      authConfig.refreshConfig.expiryPath,
    );
    if (expiryValue) {
      // Handle both absolute timestamps and relative seconds
      expiry = typeof expiryValue === "number" && expiryValue > 1000000000
        ? expiryValue * 1000 // Unix timestamp
        : Date.now() + expiryValue * 1000; // Relative seconds
    }
  }

  // Extract refresh token if configured
  const refreshToken = authConfig.refreshConfig?.refreshPath
    ? authResponse
      ? extractValue(authResponse, authConfig.refreshConfig.refreshPath)
      : undefined
    : undefined;

  return { token, expiry, refreshToken };
}

/**
 * Gets or refreshes authentication token for dynamic auth
 */
async function getDynamicToken(
  authConfig: DynamicAuth,
  baseUrl: string,
  tokenCache: Map<string, CachedToken>,
  signal: AbortSignal,
): Promise<string> {
  const cacheKey = "dynamic";
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();

  // Check if we have a valid cached token
  if (
    cached &&
    cached.expiry >
      now + (authConfig.refreshConfig?.refreshBeforeExpiry || 300) * 1000
  ) {
    return cached.token;
  }

  // Try to refresh if we have a refresh token and refresh endpoint
  if (cached?.refreshToken && authConfig.refreshConfig?.refreshEndpoint) {
    try {
      const refreshUrl =
        authConfig.refreshConfig.refreshEndpoint.startsWith("http")
          ? authConfig.refreshConfig.refreshEndpoint
          : baseUrl + authConfig.refreshConfig.refreshEndpoint;

      const refreshResponse = await fetch(refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Copilotz-Agents/1.0",
        },
        body: JSON.stringify({ refresh_token: cached.refreshToken }),
        signal,
      });

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        const newToken = extractValue(
          refreshData,
          authConfig.tokenExtraction.path ?? "",
        );
        if (newToken) {
          const newCached: CachedToken = {
            token: newToken,
            expiry: now + (authConfig.cache?.duration || 3600) * 1000,
            refreshToken: cached.refreshToken,
          };
          tokenCache.set(cacheKey, newCached);
          return newToken;
        }
      }
    } catch (error) {
      if (signal.aborted) throw actionAbortError(signal);
      if ((error as Error)?.name === "AbortError") throw error;
    }
  }

  // Get new token
  const newToken = await callAuthEndpoint(authConfig, baseUrl, signal);

  if (authConfig.cache?.enabled !== false) {
    tokenCache.set(cacheKey, newToken);
  }

  return newToken.token;
}

/**
 * Applies authentication configuration to headers and query parameters
 */
async function applyAuthentication(
  auth: API["auth"] | undefined,
  headers: Record<string, string>,
  queryParams: URLSearchParams,
  baseUrl?: string,
  tokenCache?: Map<string, CachedToken>,
  signal?: AbortSignal,
) {
  if (!auth) return;
  const normalizedAuth: AuthConfig = auth;

  switch (normalizedAuth.type) {
    case "apiKey":
      if (normalizedAuth.in === "header") {
        headers[normalizedAuth.name] = normalizedAuth.key;
      } else if (normalizedAuth.in === "query") {
        queryParams.set(normalizedAuth.name, normalizedAuth.key);
      }
      break;

    case "bearer": {
      const scheme = normalizedAuth.scheme || "Bearer";
      headers["Authorization"] = `${scheme} ${normalizedAuth.token}`;
      break;
    }
    case "basic": {
      const credentials = btoa(
        `${normalizedAuth.username}:${normalizedAuth.password}`,
      );
      headers["Authorization"] = `Basic ${credentials}`;
      break;
    }
    case "custom":
      if (normalizedAuth.headers) {
        Object.assign(headers, normalizedAuth.headers);
      }
      if (normalizedAuth.queryParams) {
        Object.entries(normalizedAuth.queryParams).forEach(([key, value]) => {
          queryParams.set(key, String(value));
        });
      }
      break;

    case "dynamic": {
      if (!baseUrl || !tokenCache || !signal) {
        throw new Error(
          "Dynamic authentication requires baseUrl, cache, and Action signal",
        );
      }

      const token = await getDynamicToken(
        normalizedAuth,
        baseUrl,
        tokenCache,
        signal,
      );

      if (normalizedAuth.tokenExtraction.type === "bearer") {
        const prefix = normalizedAuth.tokenExtraction.prefix || "Bearer ";
        headers["Authorization"] = `${prefix}${token}`;
      } else if (normalizedAuth.tokenExtraction.type === "apiKey") {
        const headerName = normalizedAuth.tokenExtraction.headerName ||
          "Authorization";
        const prefix = normalizedAuth.tokenExtraction.prefix || "";
        headers[headerName] = `${prefix}${token}`;
      }
      break;
    }
  }
}

/**
 * Creates a tool execution function for an API operation
 */
function createApiExecutor(
  apiConfig: API,
  path: string,
  method: string,
  toolKey: string,
  baseUrl: string,
  parameterMetadata: {
    pathParams: Set<string>;
    queryParams: Set<string>;
    bodyParams: Set<string>;
    isObjectBody: boolean;
  },
  tokenCache: Map<string, CachedToken>,
) {
  return async (
    args: unknown,
    context: ActionContext,
  ) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let abortReason: "timeout" | "cancelled" | undefined;
    try {
      const params = (args && typeof args === "object")
        ? args as Record<string, unknown>
        : {};

      // Build the URL
      let url = baseUrl + path;

      // Replace path parameters
      parameterMetadata.pathParams.forEach((key) => {
        if (params[key] !== undefined) {
          url = url.replace(
            `{${key}}`,
            encodeURIComponent(String(params[key])),
          );
        }
      });

      // Build query parameters (only for parameters explicitly marked as query)
      const queryParams = new URLSearchParams();
      parameterMetadata.queryParams.forEach((key) => {
        if (params[key] !== undefined) {
          queryParams.append(key, String(params[key]));
        }
      });

      // Build request headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "Copilotz-Agents/1.0",
        ...apiConfig.headers, // Legacy header support (still supported)
      };
      if (
        apiConfig.streamNdjson &&
        !Object.keys(headers).some((name) => name.toLowerCase() === "accept")
      ) {
        headers.Accept = "application/x-ndjson, application/json;q=0.9";
      }

      // Apply authentication (now async for dynamic auth)
      await applyAuthentication(
        apiConfig.auth,
        headers,
        queryParams,
        baseUrl,
        tokenCache,
        context.signal,
      );

      const requestMethod = method.toUpperCase();

      // Add body for methods that support it
      let requestBody: unknown;
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(requestMethod) &&
        parameterMetadata.bodyParams.size > 0
      ) {
        if (parameterMetadata.isObjectBody) {
          // Collect all body parameters into an object
          requestBody = {};
          const objectBody = requestBody as Record<string, unknown>;
          parameterMetadata.bodyParams.forEach((key) => {
            if (params[key] !== undefined) {
              objectBody[key] = params[key];
            }
          });
        } else {
          // Use the 'body' parameter directly
          requestBody = params.body;
        }
      }

      let preparedRequest: APIPrepareRequestInput = {
        url,
        method: requestMethod,
        headers,
        queryParams,
        body: requestBody,
      };

      if (apiConfig.prepareRequest) {
        const prepareContext: APIPrepareRequestContext = {
          apiId: apiConfig.id,
          apiName: apiConfig.name,
          actionAlias: toolKey,
          actionId: context.action.id,
          actionRunId: context.action.runId,
          operationKey: context.operationKey,
          identity: context.identity,
          actionMetadata: context.action.metadata,
          signal: context.signal,
          namespace: context.namespace,
          collections: context.collections,
          async resolveAsset(ref) {
            const id = assetIdFromRef(context.namespace, ref);
            const asset = await context.content.get(id);
            if (!asset) throw new Error(`Asset '${id}' was not found.`);
            const resolved = await context.content.resolve({
              assetId: id,
              kind: attachmentKind(asset.mediaType),
              role: "attachment",
              mediaType: asset.mediaType,
            });
            return { bytes: resolved.bytes, mime: asset.mediaType };
          },
        };
        preparedRequest =
          (await apiConfig.prepareRequest(preparedRequest, prepareContext)) ??
            preparedRequest;
      }

      // Add final query parameters to URL after prepareRequest has had a
      // chance to mutate them.
      url = preparedRequest.url;
      const finalQueryParams = preparedRequest.queryParams;
      if (finalQueryParams.toString()) {
        url += (url.includes("?") ? "&" : "?") + finalQueryParams.toString();
      }

      // Build request options
      const requestOptions: RequestInit = {
        method: preparedRequest.method,
        headers: preparedRequest.headers,
      };

      if (preparedRequest.body !== undefined) {
        requestOptions.body = typeof preparedRequest.body === "string"
          ? preparedRequest.body
          : JSON.stringify(preparedRequest.body);
      }

      // Set cancellation / timeout
      const controller = new AbortController();
      const abort = () => {
        abortReason = "cancelled";
        controller.abort(context.signal.reason);
      };
      context.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () =>
        context.signal.removeEventListener("abort", abort);
      timeoutId = typeof apiConfig.timeout === "number" && apiConfig.timeout > 0
        ? setTimeout(() => {
          if (!controller.signal.aborted) {
            abortReason = "timeout";
            controller.abort();
          }
        }, apiConfig.timeout * 1000)
        : undefined;
      requestOptions.signal = controller.signal;
      if (context.signal.aborted) abort();

      // Make the request
      const response = await fetch(url, requestOptions);

      // Parse response
      const contentType = response.headers.get("content-type") || "";
      let responseData;

      if (
        apiConfig.streamNdjson &&
        contentType.toLowerCase().includes("application/x-ndjson")
      ) {
        responseData = await consumeNdjsonToolResponse(
          response,
          context,
        );
      } else if (contentType.includes("application/json")) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }
      responseData = sanitizeToolJsonValue(responseData);

      if (!response.ok) {
        throw new ToolExecutionError(
          responseData,
          response.status,
          response.statusText,
        );
      }

      const assetMapping = apiConfig.responseAssets?.[toolKey];
      const result = assetMapping
        ? await promoteResponseAssets(
          responseData,
          assetMapping,
          context,
          toolKey,
        )
        : responseData;

      if (apiConfig.includeResponseHeaders) {
        return {
          body: result,
          headers: sanitizeToolJsonValue(
            Object.fromEntries(response.headers.entries()),
          ),
        };
      }

      return result;
    } catch (error) {
      if (context.signal.aborted) throw actionAbortError(context.signal);
      if (error instanceof Error && error.name === "AbortError") {
        if (abortReason === "timeout") {
          throw new Error(`Request timeout after ${apiConfig.timeout} seconds`);
        }
        throw error;
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      removeAbortListener?.();
    }
  };
}

function generateApiEntries(apiConfig: API): readonly OpenApiGeneratedTool[] {
  const entries: OpenApiGeneratedTool[] = [];
  const tokenCache = new Map<string, CachedToken>();
  const schema = dereferenceOpenApiLocalRefs(
    normalizeOpenApiSchema(apiConfig.openApiSchema),
  );

  // Determine base URL
  const baseUrl = apiConfig.baseUrl ||
    (schema.servers && schema.servers.length > 0 ? schema.servers[0].url : "");

  if (!baseUrl) {
    throw new Error(
      `No base URL found for API ${apiConfig.name}. Provide baseUrl in config or servers in OpenAPI schema.`,
    );
  }

  // Process each path and method
  Object.entries(schema.paths).forEach(([path, pathItem]) => {
    Object.entries(pathItem).forEach(([method, operation]) => {
      // Skip non-operation properties
      if (
        !["get", "post", "put", "patch", "delete", "options", "head"].includes(
          method.toLowerCase(),
        )
      ) {
        return;
      }

      const op = operation as OpenAPIOperation;

      // Generate tool key and name
      const rawAlias = op.operationId ||
        `${apiConfig.id}_${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const actionAlias = generatedActionAlias(rawAlias, "api");

      const toolName = op.summary ||
        `${method.toUpperCase()} ${path}`;

      const toolDescription = op.description ||
        `${
          apiConfig.description ? apiConfig.description + ": " : ""
        }${toolName}`;

      // Convert OpenAPI parameters to JSON Schema
      const { schema: inputSchema, parameterMetadata } =
        convertParameterToJsonSchema(op.parameters, op.requestBody);

      const action = defineAction({
        id: `copilotz.tools.openapi.${
          generatedActionIdSegment(apiConfig.id, "api")
        }.${generatedActionIdSegment(actionAlias, "operation")}`,
        inputSchema,
        execute: createApiExecutor(
          apiConfig,
          path,
          method,
          actionAlias,
          baseUrl,
          parameterMetadata,
          tokenCache,
        ),
      });
      const tool = defineTool(actionAlias, action, {
        name: toolName,
        description: toolDescription,
        ...((apiConfig.toolPolicies?.[actionAlias] ??
            apiConfig.historyPolicyDefaults)
          ? {
            history: apiConfig.toolPolicies?.[actionAlias] ??
              apiConfig.historyPolicyDefaults,
          }
          : {}),
        metadata: {
          apiId: apiConfig.id,
          method: method.toUpperCase(),
          path,
        },
      });

      entries.push(Object.freeze({ alias: actionAlias, action, tool }));
    });
  });

  return Object.freeze(entries);
}

export type DefinedApi<TApi extends API = API> = TApi;

const API_CONFIG_KEYS = new Set([
  "id",
  "name",
  "externalId",
  "description",
  "openApiSchema",
  "baseUrl",
  "headers",
  "auth",
  "timeout",
  "includeResponseHeaders",
  "streamNdjson",
  "prepareRequest",
  "responseAssets",
  "metadata",
  "historyPolicyDefaults",
  "toolPolicies",
]);
const API_DECLARATION_ALIAS = /^[a-z][a-zA-Z0-9_]*$/;
const UNSAFE_API_DECLARATION_ALIASES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotApiJson<T>(value: T, label: string): T {
  return value === undefined || value === null
    ? value
    : cloneLosslessJson(value, label);
}

function declarationAlias(value: string): string {
  if (
    !API_DECLARATION_ALIAS.test(value) ||
    UNSAFE_API_DECLARATION_ALIASES.has(value)
  ) {
    throw new TypeError(`OpenAPI declaration has invalid alias '${value}'.`);
  }
  return value;
}

/**
 * Names an OpenAPI integration at its declaration site. It deliberately keeps
 * transport callbacks on the API definition; generated Tool Resources remain
 * data-only.
 */
export function defineApi<const TApi extends API>(
  config: TApi,
): DefinedApi<TApi> {
  if (!isPlainRecord(config)) {
    throw new TypeError("API definition must be an object.");
  }
  const unknown = Object.keys(config).find((key) => !API_CONFIG_KEYS.has(key));
  if (unknown) {
    throw new TypeError(`API definition cannot declare '${unknown}'.`);
  }
  if (typeof config.id !== "string" || !config.id.trim()) {
    throw new TypeError("API id is required.");
  }
  if (typeof config.name !== "string" || !config.name.trim()) {
    throw new TypeError("API name is required.");
  }
  return Object.freeze({
    ...config,
    ...(config.openApiSchema && typeof config.openApiSchema === "object"
      ? {
        openApiSchema: snapshotApiJson(
          config.openApiSchema,
          "API OpenAPI schema",
        ),
      }
      : {}),
    ...(config.headers
      ? { headers: snapshotApiJson(config.headers, "API headers") }
      : {}),
    ...(config.metadata
      ? { metadata: snapshotApiJson(config.metadata, "API metadata") }
      : {}),
    ...(config.responseAssets
      ? {
        responseAssets: snapshotApiJson(
          config.responseAssets,
          "API response assets",
        ),
      }
      : {}),
    ...(config.historyPolicyDefaults
      ? {
        historyPolicyDefaults: snapshotApiJson(
          config.historyPolicyDefaults,
          "API history policy",
        ),
      }
      : {}),
    ...(config.toolPolicies
      ? {
        toolPolicies: snapshotApiJson(config.toolPolicies, "API Tool policies"),
      }
      : {}),
  }) as DefinedApi<TApi>;
}

export type OpenApiDefinitions = Readonly<Record<string, API>>;

export type CreateOpenApiToolsPluginOptions = Readonly<{
  /** Array form retains one generated Tool per operation. */
  apis: readonly API[] | OpenApiDefinitions;
  id?: string;
  version?: string;
}>;

/** Concrete plugin shape produced by OpenAPI discovery. */
export type { OpenApiToolsPlugin } from "../../plugin.ts";

/** Discovers every OpenAPI operation before runtime composition. */
export function createOpenApiToolsPlugin(
  options: CreateOpenApiToolsPluginOptions,
): OpenApiToolsPlugin {
  if (!options || !options.apis || typeof options.apis !== "object") {
    throw new TypeError("OpenAPI Tool plugin requires APIs.");
  }
  const entries: OpenApiGeneratedTool[] = [];
  const aliases = new Set<string>();
  const actionIds = new Set<string>();
  const apiEntries = Array.isArray(options.apis)
    ? options.apis.map((api) => [undefined, api] as const)
    : (() => {
      if (!isPlainRecord(options.apis)) {
        throw new TypeError(
          "OpenAPI APIs must be an array or plain alias map.",
        );
      }
      return Object.entries(options.apis).map(([alias, api]) =>
        [declarationAlias(alias), api as API] as const
      );
    })();
  for (const [alias, api] of apiEntries) {
    const generated = generateApiEntries(api);
    for (const entry of generated) {
      assertGeneratedEntryUnique(
        aliases,
        actionIds,
        entry.alias,
        entry.action.id,
        `OpenAPI '${api.id}'${alias === undefined ? "" : ` (${alias})`}`,
      );
      entries.push(entry);
    }
  }
  return composeOpenApiToolsPlugin({
    id: options.id ?? "@copilotz/openapi-tools",
    version: options.version ?? "3.0.0",
    entries,
  });
}
