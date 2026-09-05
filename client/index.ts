/** Fetch-only client for the canonical Copilotz HTTP facade. @module */

import {
  decodeObservation,
  type ObservationFrame,
  ProtocolError,
  TruncatedObservationError,
} from "./protocol.ts";
export {
  decodeObservation,
  type ObservationFrame,
  ProtocolError,
} from "./protocol.ts";

export type OperationReceipt = Readonly<{
  operationId: string;
  correlationId: string;
  status: string;
  acceptedAt: string;
  checkpoint?: string;
  thread?: Readonly<{ id: string; externalId: string }>;
}>;
export type ReadOptions = Readonly<{ signal?: AbortSignal }>;
export type SubmitOptions = Readonly<
  { idempotencyKey: string; signal?: AbortSignal }
>;
export type ObserveOptions = Readonly<{
  checkpoint?: string;
  signal?: AbortSignal;
  onFrame(frame: ObservationFrame): void | Promise<void>;
}>;
export type ClientOptions = Readonly<{
  baseUrl: string;
  getRequestHeaders?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof globalThis.fetch;
}>;

class TransportError extends TypeError {}

export class CopilotzHttpError extends Error {
  override name = "CopilotzHttpError";
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function segment(value: string): string {
  if (!value || value === "." || value === "..") {
    throw new TypeError("Invalid path segment.");
  }
  return encodeURIComponent(value);
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createCopilotzClient(options: ClientOptions): CopilotzClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(await options.getRequestHeaders?.());
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    let response!: Response;
    const reading = !init.method || init.method === "GET";
    for (let attempt = 0;; attempt++) {
      init.signal?.throwIfAborted();
      try {
        response = await fetcher(`${base}${path}`, { ...init, headers });
        if (!reading || response.status !== 503 || attempt >= 2) break;
        await response.body?.cancel();
      } catch (error) {
        if (!(error instanceof TypeError) || init.signal?.aborted) throw error;
        if (!reading || attempt >= 2) {
          throw new TransportError(error.message, { cause: error });
        }
      }
      await pause(100 * 2 ** attempt, init.signal ?? undefined);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = body.error ?? body;
      throw new CopilotzHttpError(
        response.status,
        error.code ?? "http_error",
        error.message ?? response.statusText,
      );
    }
    return response;
  };
  const json = async (
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> => {
    const response = await request(path, init);
    return response.status === 204 ? undefined : await response.json();
  };
  const body = (value: unknown): RequestInit => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  const submit = async (
    path: string,
    input: unknown,
    submitOptions: SubmitOptions,
  ): Promise<OperationReceipt> => {
    if (!submitOptions.idempotencyKey.trim()) {
      throw new TypeError("Idempotency key is required.");
    }
    const serialized = body(input);
    const key = submitOptions.idempotencyKey;
    for (let attempt = 0;; attempt++) {
      let responseReceived = false;
      try {
        const response = await request(path, {
          method: "POST",
          ...serialized,
          signal: submitOptions.signal,
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
        });
        responseReceived = true;
        if (response.status !== 202) {
          throw new ProtocolError("Submission did not return a receipt.");
        }
        const receipt = (await response.json()).data;
        if (typeof receipt.operationId !== "string" || !receipt.operationId) {
          throw new ProtocolError("Invalid operation receipt.");
        }
        return receipt;
      } catch (error) {
        if (
          submitOptions.signal?.aborted || error instanceof CopilotzHttpError ||
          error instanceof ProtocolError ||
          !(error instanceof TransportError ||
            responseReceived && error instanceof TypeError) ||
          attempt >= 2
        ) throw error;
        // Lost responses reuse the same input and identity, never a new execution key.
        await pause(100 * 2 ** attempt, submitOptions.signal);
      }
    }
  };
  const observe = async (
    path: string,
    selection: unknown,
    observation: ObserveOptions,
  ): Promise<string | undefined> => {
    let checkpoint = observation.checkpoint;
    for (let attempt = 0;; attempt++) {
      let applying = false;
      let responseReceived = false;
      try {
        const response = await request(path, {
          method: "POST",
          ...body({ ...selection as object, checkpoint }),
          signal: observation.signal,
          headers: {
            "content-type": "application/json",
            accept: "multipart/mixed",
          },
        });
        responseReceived = true;
        for await (const frame of decodeObservation(response)) {
          applying = true;
          await observation.onFrame(frame);
          applying = false;
          checkpoint = frame.checkpoint;
          if (
            frame.kind === "output" && frame.output.type === "replay.capacity"
          ) {
            throw new CopilotzHttpError(
              409,
              "operation_replay_capacity_exceeded",
              "Observation capacity exceeded; bootstrap a fresh history checkpoint.",
            );
          }
          attempt = 0;
        }
        return checkpoint;
      } catch (error) {
        if (
          applying || observation.signal?.aborted ||
          error instanceof CopilotzHttpError ||
          (error instanceof ProtocolError &&
            !(error instanceof TruncatedObservationError)) ||
          (!(error instanceof TransportError) &&
            !(responseReceived && error instanceof TypeError) &&
            !(error instanceof TruncatedObservationError)) ||
          attempt >= 3
        ) throw error;
        await pause(100 * 2 ** attempt, observation.signal);
      }
    }
  };
  const result = async (
    operationId: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const path = `/operations/${segment(operationId)}/result`;
    for (;;) {
      const response = await request(path, { signal });
      if (response.status !== 202) return (await response.json()).data;
      await pause(100, signal);
    }
  };
  const actionPath = (id: string) =>
    `/actions/${id.split(".").map(segment).join("/")}`;
  return Object.freeze({
    actions: Object.freeze({
      submit: (id: string, input: unknown, options: SubmitOptions) =>
        submit(actionPath(id), input, options),
      async invoke(id: string, input: unknown, options: SubmitOptions) {
        const receipt = await submit(actionPath(id), input, options);
        return await result(receipt.operationId, options.signal);
      },
    }),
    channels: Object.freeze({
      submit: (alias: string, input: unknown, options: SubmitOptions) =>
        submit(`/channels/${segment(alias)}`, input, options),
    }),
    operations: Object.freeze({
      get: (id: string) => json(`/operations/${segment(id)}`),
      result,
      cancel: (id: string) =>
        json(`/operations/${segment(id)}`, { method: "DELETE" }),
      observe: (
        options: ObserveOptions & { operationIds: readonly string[] },
      ) => {
        if (!options.operationIds.length || options.operationIds.length > 32) {
          throw new RangeError("Select between 1 and 32 operations.");
        }
        return observe("/operations/observe", {
          operationIds: options.operationIds,
        }, options);
      },
    }),
    collections: Object.freeze({
      get: (name: string, id: string) =>
        json(`/collections/${segment(name)}/${segment(id)}`),
      list: (name: string, query: unknown = {}) =>
        json(
          `/collections/${segment(name)}?query=${
            encodeURIComponent(JSON.stringify(query))
          }`,
        ),
      query: (name: string, queryName: string, input: unknown) =>
        json(`/collections/${segment(name)}/queries/${segment(queryName)}`, {
          method: "POST",
          ...body(input),
        }),
    }),
    assets: Object.freeze({
      upload: (
        input: BodyInit,
        options: {
          mediaType?: string;
          filename?: string;
          idempotencyKey?: string;
          signal?: AbortSignal;
        } = {},
      ) =>
        json("/assets", {
          method: "POST",
          body: input,
          signal: options.signal,
          headers: {
            ...(options.idempotencyKey
              ? { "idempotency-key": options.idempotencyKey }
              : {}),
            "content-type": options.mediaType ?? "application/octet-stream",
            ...(options.filename
              ? {
                "content-disposition": `attachment; filename*=UTF-8''${
                  encodeURIComponent(options.filename)
                }`,
              }
              : {}),
          },
        }),
      get: (id: string, options: ReadOptions = {}) =>
        request(`/assets/${segment(id)}`, options),
    }),
    /** Shared request machinery for typed domain clients and application endpoints. */
    http: Object.freeze({ request, json, submit, observe }),
  });
}

export type CopilotzClient = Readonly<{
  actions: Readonly<{
    submit(
      id: string,
      input: unknown,
      options: SubmitOptions,
    ): Promise<OperationReceipt>;
    invoke(
      id: string,
      input: unknown,
      options: SubmitOptions,
    ): Promise<unknown>;
  }>;
  channels: Readonly<{
    submit(
      alias: string,
      input: unknown,
      options: SubmitOptions,
    ): Promise<OperationReceipt>;
  }>;
  operations: Readonly<{
    get(id: string): Promise<unknown>;
    result(id: string, signal?: AbortSignal): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
    observe(
      options: ObserveOptions & { operationIds: readonly string[] },
    ): Promise<string | undefined>;
  }>;
  collections: Readonly<{
    get(name: string, id: string): Promise<unknown>;
    list(name: string, query?: unknown): Promise<unknown>;
    query(name: string, queryName: string, input: unknown): Promise<unknown>;
  }>;
  assets: Readonly<{
    upload(
      input: BodyInit,
      options?: {
        mediaType?: string;
        filename?: string;
        idempotencyKey?: string;
        signal?: AbortSignal;
      },
    ): Promise<unknown>;
    get(id: string, options?: ReadOptions): Promise<Response>;
  }>;
  http: Readonly<{
    request(path: string, init?: RequestInit): Promise<Response>;
    json(path: string, init?: RequestInit): Promise<unknown>;
    submit(
      path: string,
      input: unknown,
      options: SubmitOptions,
    ): Promise<OperationReceipt>;
    observe(
      path: string,
      selection: unknown,
      options: ObserveOptions,
    ): Promise<string | undefined>;
  }>;
}>;
