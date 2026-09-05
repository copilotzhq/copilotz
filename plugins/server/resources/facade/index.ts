/** Defines the immutable semantic Server facade Resource. @module */

import type {
  DefineServerFacadeInput,
  ServerCollectionExposure,
  ServerFacadeResource,
  ServerPatternPolicy,
} from "../../internal/contracts.ts";
import { DEFAULT_SERVER_ASSET_UPLOAD_BYTES as defaultMaxAssetUploadBytes } from "../../internal/contracts.ts";

export { DEFAULT_SERVER_ASSET_UPLOAD_BYTES } from "../../internal/contracts.ts";

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) throw new TypeError(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function routePath(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty path.`);
  }
  const parts = value.split("/").filter(Boolean);
  if (
    parts.some((part) =>
      part === "." || part === ".." || part.startsWith(":") ||
      /^v[0-9]+$/.test(part)
    )
  ) {
    throw new TypeError(`${label} cannot contain relative segments.`);
  }
  return parts.length ? `/${parts.join("/")}` : "/";
}

function patterns(
  value: unknown,
  label: string,
): ServerPatternPolicy {
  const input = plainRecord(value, label);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => key !== "include" && key !== "exclude")) {
    throw new TypeError(`${label} contains unsupported fields.`);
  }
  const list = (candidate: unknown, name: string): readonly string[] => {
    if (candidate === undefined) return Object.freeze([]);
    if (!Array.isArray(candidate)) {
      throw new TypeError(`${label}.${name} must be an array.`);
    }
    return Object.freeze(candidate.map((entry, index) => {
      if (typeof entry !== "string" || !entry || entry.trim() !== entry) {
        throw new TypeError(`${label}.${name}[${index}] is invalid.`);
      }
      return entry;
    }));
  };
  return Object.freeze({
    include: patternsOrDefault(input.include, "include", list, ["*"]),
    exclude: patternsOrDefault(input.exclude, "exclude", list, []),
  });
}

function patternsOrDefault(
  value: unknown,
  name: string,
  read: (value: unknown, name: string) => readonly string[],
  fallback: readonly string[],
): readonly string[] {
  return value === undefined ? Object.freeze([...fallback]) : read(value, name);
}

function exposure(
  value: unknown,
  label: string,
  collection = false,
): boolean | ServerPatternPolicy | ServerCollectionExposure {
  if (value === undefined || value === true) return true;
  if (value === false) return false;
  const input = plainRecord(value, label);
  if (!collection) return patterns(input, label);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) =>
      key !== "include" && key !== "exclude" && key !== "operations"
    )
  ) throw new TypeError(`${label} contains unsupported fields.`);
  const base = patterns(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "operations"),
    ),
    label,
  );
  const operations = input.operations === undefined ||
      input.operations === true
    ? true
    : input.operations === false
    ? false
    : patterns(input.operations, `${label}.operations`);
  return Object.freeze({ ...base, operations });
}

function maxAssetUploadBytes(value: unknown): number {
  if (value === undefined) return defaultMaxAssetUploadBytes;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "Server facade maxAssetUploadBytes must be a positive integer.",
    );
  }
  return value;
}

/** Validates one process-local Server facade declaration. */
export function defineServerFacade(
  input: DefineServerFacadeInput = {},
): ServerFacadeResource {
  if (
    !input || typeof input !== "object" || Array.isArray(input) ||
    Reflect.ownKeys(input).some((key) =>
      key !== "basePath" && key !== "expose" &&
      key !== "authenticate" && key !== "authorize" &&
      key !== "maxAssetUploadBytes"
    )
  ) throw new TypeError("Server facade definition is invalid.");
  for (const key of ["authenticate", "authorize"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "function") {
      throw new TypeError(`Server ${key} must be a function.`);
    }
  }
  const expose = input.expose === undefined
    ? {}
    : plainRecord(input.expose, "Server facade expose");
  if (
    Reflect.ownKeys(expose).some((key) =>
      key !== "actions" && key !== "collections" && key !== "channels"
    )
  ) throw new TypeError("Server facade categories are invalid.");
  return Object.freeze({
    basePath: routePath(input.basePath ?? "/api", "Server facade basePath"),
    maxAssetUploadBytes: maxAssetUploadBytes(input.maxAssetUploadBytes),
    expose: Object.freeze({
      actions: exposure(expose.actions, "Server action exposure") as
        | boolean
        | ServerPatternPolicy,
      collections: exposure(
        expose.collections,
        "Server collection exposure",
        true,
      ) as boolean | ServerCollectionExposure,
      channels: exposure(expose.channels, "Server channel exposure") as
        | boolean
        | ServerPatternPolicy,
    }),
    ...(input.authenticate ? { authenticate: input.authenticate } : {}),
    ...(input.authorize ? { authorize: input.authorize } : {}),
  });
}

export type {
  DefineServerFacadeInput,
  ServerAuthenticate,
  ServerAuthenticationContext,
  ServerAuthorize,
  ServerAuthorizedScope,
  ServerCollectionExposure,
  ServerConstraints,
  ServerEndpointDescriptor,
  ServerExposureOptions,
  ServerFacadeResource,
  ServerPatternPolicy,
} from "../../internal/contracts.ts";
