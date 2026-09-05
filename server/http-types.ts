import type { ApplicationOutput } from "../runtime/application/types.ts";

export type HttpRequest = Readonly<{
  resource: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: readonly string[];
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  context?: Readonly<
    Record<string, unknown> & {
      namespace?: string;
      databaseSchema?: string;
    }
  >;
}>;

export type HttpResponse = Readonly<{
  status: number;
  headers?: HeadersInit;
  data?: unknown;
  pageInfo?: Readonly<{
    next?: string;
    hasMore: boolean;
  }>;
}>;

export type HttpError =
  & Error
  & Readonly<{
    status: number;
    code: string;
  }>;

export const HTTP_OBSERVATION = "copilotz.output-stream";

/** Framework-neutral request-bound channel output. */
export type HttpObservation = Readonly<{
  type: typeof HTTP_OBSERVATION;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  operationId?: string;
  threadId?: string;
  replayCursor?: string;
  /** Thread feeds track one durable Event position per operation. */
  compositeCursor?: boolean;
  /** Transport interruption detaches; it never durably cancels an operation. */
  cancel(reason?: string): Promise<void>;
}>;

export type HttpApplication = Readonly<{
  handle(request: HttpRequest): Promise<HttpResponse>;
}>;

export function isHttpObservation(
  value: unknown,
): value is HttpObservation {
  const candidate = value as Partial<HttpObservation> | undefined;
  return Boolean(
    value && typeof value === "object" &&
      candidate?.type === HTTP_OBSERVATION &&
      typeof (candidate.outputs as { getReader?: unknown } | undefined)
          ?.getReader === "function" &&
      typeof (candidate.done as { then?: unknown } | undefined)?.then ===
        "function" &&
      typeof candidate.cancel === "function",
  );
}
