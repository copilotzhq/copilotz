import type { CopilotzApplication } from "../application/index.ts";

export type FeatureRequest = Readonly<{
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

export type FeatureResponse = Readonly<{
  status: number;
  /** Transport headers such as Set-Cookie or a content disposition. */
  headers?: HeadersInit;
  data?: unknown;
  /** Canonical related resources requested through an `include` query. */
  included?: unknown;
  pageInfo?: Readonly<{
    next?: string;
    hasMore: boolean;
  }>;
}>;

export type FeatureContext = Readonly<{
  application: CopilotzApplication;
  namespace: string;
  databaseSchema: string;
  request: FeatureRequest;
}>;

export type FeatureAction = (
  request: FeatureRequest,
  context: FeatureContext,
) => unknown | Promise<unknown>;

/** Transport-neutral named application capability contributed by a plugin. */
export type FeatureResource = Readonly<{
  id: string;
  actions: Readonly<Record<string, FeatureAction>>;
}>;
