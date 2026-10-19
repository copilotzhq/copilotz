/** Registration validation and declaration-bound preparation; no runtime authority. */
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import {
  actionSchemaHasSecrets,
  protectedActionStrings,
  splitSecretActionValue,
} from "./secret.ts";
import { sameActionValue } from "./value.ts";
import type { AnyActionDefinition } from "./types.ts";
import type { ProtectedActionDefinitions } from "./protected-action-types.ts";

export function revisionPath(pointer: string): readonly string[] {
  if (
    typeof pointer !== "string" || !pointer.startsWith("/") ||
    pointer.length > 1024 || /~(?:[^01]|$)/.test(pointer)
  ) {
    throw new TypeError("Public revision fields require exact JSON Pointers.");
  }
  const result = pointer.slice(1).split("/").map((part) =>
    part.replace(/~1/g, "/").replace(/~0/g, "~")
  );
  if (
    result.some((part) =>
      !part || ["__proto__", "constructor", "prototype"].includes(part)
    )
  ) {
    throw new TypeError("Invalid public revision field.");
  }
  return result;
}

export function validateProtectedActions(
  definitions: ProtectedActionDefinitions | undefined,
  actions: Readonly<Record<string, AnyActionDefinition>>,
): ProtectedActionDefinitions {
  if (
    definitions !== undefined &&
    (!definitions || typeof definitions !== "object" ||
      Array.isArray(definitions))
  ) {
    throw new TypeError("protectedActions must be a registration map.");
  }
  const entries = Object.entries(definitions ?? {}).map(([id, definition]) => {
    const action = Object.values(actions).find((action) => action.id === id);
    if (
      !action || !definition || typeof definition.authorize !== "function" ||
      typeof definition.prepareInput !== "function"
    ) {
      throw new TypeError(
        "Protected Actions require registered definitions, authorization and an owner phase.",
      );
    }
    if (!actionSchemaHasSecrets(action.inputSchema)) {
      throw new TypeError(
        "Protected input preparation requires declared secret slots.",
      );
    }
    if (action.content) {
      throw new TypeError(
        "Protected Action hooks do not accept content inputs.",
      );
    }
    const revisions = definition.publicRevisionFields ?? [];
    if (!Array.isArray(revisions)) {
      throw new TypeError("Public revision fields require input preparation.");
    }
    const paths = revisions.map(revisionPath);
    const coordinates = new Set([
      "id",
      "namespace",
      "databaseSchema",
      "actionId",
      "actionRunId",
      "parentActionRunId",
      "sourceEventId",
      "sourceDeliveryId",
      "ownerId",
      "principal",
      "identity",
      "actor",
      "owner",
      "user",
      "userId",
      "tenantId",
      "workspaceId",
      "threadId",
      "provider",
      "providerId",
      "actorId",
      "accountId",
      "operationId",
      "settlementScopeId",
    ]);
    if (
      paths.some((path) =>
        path.some((part) => coordinates.has(part) || /(?:Id|_id)$/.test(part))
      )
    ) {
      throw new TypeError(
        "Public revision fields cannot select ownership or identity coordinates.",
      );
    }
    for (let i = 0; i < paths.length; i++) {
      if (
        paths.some((path, j) =>
          i !== j && paths[i].every((part, k) => path[k] === part)
        )
      ) {
        throw new TypeError("Public revision fields must not overlap.");
      }
      let node: unknown = action.inputSchema;
      for (const segment of paths[i]) {
        const record = node as Record<string, unknown> | undefined;
        if (
          !record || record["x-copilotz-secret"] || record.$ref ||
          !record.properties
        ) {
          throw new TypeError(
            "Public revision fields must name explicit public properties.",
          );
        }
        node = (record.properties as Record<string, unknown>)[segment];
      }
      const leaf = node as Record<string, unknown> | undefined;
      const types = Array.isArray(leaf?.type) ? leaf.type : [leaf?.type];
      if (
        !leaf || actionSchemaHasSecrets(leaf) || !types.length ||
        types.some((type) =>
          !["string", "integer", "number", "null"].includes(String(type))
        )
      ) {
        throw new TypeError(
          "Public revision fields must be declared scalar revision values.",
        );
      }
    }
    return [
      id,
      Object.freeze({
        ...definition,
        publicRevisionFields: Object.freeze([...revisions]),
      }),
    ] as const;
  });
  const registered = Object.fromEntries(entries);
  for (const action of Object.values(actions)) {
    if (
      action.ownerHooks?.prepareInput && !registered[action.id]?.prepareInput
    ) {
      throw new TypeError(
        "A required protected Action owner hook is missing.",
      );
    }
  }
  return Object.freeze(registered);
}

function redacted(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>)["$copilotz-secret"] === true;
}
/** Omits only schema-redacted values and explicitly registered revision fields. */
export function protectedActionPublicInput(
  action: AnyActionDefinition,
  input: unknown,
  revisions: readonly string[] = [],
): unknown {
  const allowed = new Set(revisions);
  const visit = (value: unknown, path: string): unknown => {
    if (allowed.has(path) || redacted(value)) return undefined;
    if (Array.isArray(value)) {
      return value.map((child, index) =>
        visit(child, `${path}/${index}`) ?? null
      );
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, child]) => {
          const result = visit(
            child,
            `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
          );
          return result === undefined ? [] : [[key, result]];
        }),
      );
    }
    return value;
  };
  return visit(
    splitSecretActionValue(action.inputSchema, input).publicValue,
    "",
  ) ?? null;
}
export function capturePreparedActionInput(
  action: AnyActionDefinition,
  original: unknown,
  result: unknown,
  revisions: readonly string[] = [],
): unknown {
  const captured = captureHostCommandJson(result);
  try {
    if (action.inputSchema) {
      validateAgainstJsonSchema(
        action.inputSchema,
        captured,
        "Protected Action input",
      );
    }
    if (
      !sameActionValue(
        protectedActionPublicInput(action, original, revisions),
        protectedActionPublicInput(action, captured, revisions),
      )
    ) {
      throw new Error("changed input");
    }
  } catch {
    throw new TypeError(
      "Protected Action preparation changed an undeclared field or produced invalid input.",
    );
  }
  return captured;
}

/** Lifecycle metadata must never smuggle a schema-marked input value. */
export function assertProtectedActionMetadata(
  action: AnyActionDefinition,
  input: unknown,
  metadata: unknown,
): void {
  const encoded = JSON.stringify(metadata);
  if (
    protectedActionStrings(action.inputSchema, input).some((value) =>
      encoded.includes(value)
    )
  ) {
    throw new TypeError(
      "Protected Action metadata contains a protected value.",
    );
  }
}
