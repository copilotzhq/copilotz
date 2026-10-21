/** Owner-only credential effects. Durable rows contain public claims, never tokens. */
import {
  type AuthenticatedAuthority,
  credentialValidity,
  retainedAuthority,
} from "./authority.ts";
import { authorizationRefused, type OwnerEvaluator } from "./evaluator.ts";
import {
  captureCollectionCommandInvocation,
  type CollectionInvocationAuthority,
} from "./invocation.ts";
import {
  type CommandContext,
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import type { SqlSession } from "../events/session.ts";
import type { SecretAdapter } from "../actions/secret-adapter.ts";
import {
  ensureOwnerDataKey,
  readOwnerDataKey,
  unwrapOwnerDataKey,
} from "../actions/owner-data-key.ts";
import { digestContent } from "../content/digest.ts";
import { stableStringify } from "../collections/equal.ts";
import type { CredentialEffectMethod } from "../actions/session-effects.ts";

export type CredentialClaims = Readonly<{
  type: "session" | "flow" | "clear";
  id: string;
  schema: string;
  namespace: string;
  tenant: string;
  principal: string;
  expiresAt: string;
  kind?: string;
  continuation?: string;
  actionId?: string;
}>;
type EffectRow = {
  claims: CredentialClaims;
  intent: unknown;
  initiator: string;
  run_id: string;
  operation_id: string;
  method: string;
  consumed_run: string | null;
};
export type CredentialProjection = Readonly<
  { claims: CredentialClaims; token?: string }
>;
const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
const bytes = (value: string) => new TextEncoder().encode(value);
const identity = (authority: AuthenticatedAuthority) =>
  stableStringify({
    principal: authority.principal,
    basis: authority.authorityBasis,
    policy: authority.policy,
    proof: authority.scope.bindings["@credential-proof"] ?? "",
  });

export type CredentialEffects = Readonly<{
  commit(
    binding: CollectionInvocationAuthority | undefined,
    method: CredentialEffectMethod,
    input: unknown,
    key: string,
    command: CommandContext,
  ): Promise<void>;
  project(
    authority: AuthenticatedAuthority,
    operationId: string,
  ): Promise<readonly CredentialProjection[]>;
  authenticate(
    selected: AuthenticatedAuthority,
    token: string,
    type: "session" | "flow",
  ): Promise<AuthenticatedAuthority>;
}>;

export function createCredentialEffects(options: {
  session: SqlSession;
  schema: string;
  master?: SecretAdapter;
  evaluate?: OwnerEvaluator;
  actions: Readonly<Record<string, { id: string }>>;
  authorizeProjection(
    authority: AuthenticatedAuthority,
    operationId: string,
    command: CommandContext,
  ): Promise<unknown>;
  create(
    authority: AuthenticatedAuthority,
    input: { id: string; principal: string; expiresAt: string },
    command: CommandContext,
    invocation?: { kind: "action"; id: string; runId: string },
  ): Promise<void>;
  revoke(
    authority: AuthenticatedAuthority,
    id: string,
    command: CommandContext,
    invocation?: { kind: "action"; id: string; runId: string },
  ): Promise<void>;
}): CredentialEffects {
  const table = `"${options.schema}".authorization_effects`;
  const run = createSchemaCommandRunner(options.session, options.schema);
  const signingKey = async (command: CommandContext, create: boolean) => {
    if (!options.master) {
      throw new Error("Credential effects require a Secret Adapter.");
    }
    const row = create
      ? await ensureOwnerDataKey(
        command.transaction,
        options.schema,
        options.master,
      )
      : await readOwnerDataKey(command.transaction, options.schema);
    if (!row) authorizationRefused();
    const material = await unwrapOwnerDataKey(
      options.schema,
      row,
      options.master,
    );
    const keyMaterial = new Uint8Array(material);
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        keyMaterial,
        "HKDF",
        false,
        ["deriveKey"],
      );
      return await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new TextEncoder().encode("copilotz.owner.credentials.v1"),
          info: new TextEncoder().encode("credential-token-hmac"),
        },
        key,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    } finally {
      keyMaterial.fill(0);
      material.fill(0);
    }
  };
  const tokenFor = async (
    claims: CredentialClaims,
    command: CommandContext,
  ) => {
    const payload = encode(bytes(stableStringify(claims)));
    const signature = await crypto.subtle.sign(
      "HMAC",
      await signingKey(command, false),
      bytes(`copilotz.credential.v1.${payload}`),
    );
    return `${payload}.${encode(new Uint8Array(signature))}`;
  };
  return {
    async commit(
      binding: CollectionInvocationAuthority | undefined,
      method: CredentialEffectMethod,
      input: unknown,
      key: string,
      command: CommandContext,
    ) {
      schemaCommandContext(command.transaction, options.schema);
      if (
        !binding || binding.invocation.kind !== "action" ||
        binding.scope.databaseSchema !== options.schema || !options.evaluate
      ) authorizationRefused();
      const invocation = captureCollectionCommandInvocation(binding, command);
      invocation.check();
      await invocation.assertCurrent?.(command, invocation.invocation);
      const source = await invocation.resolveSource(command.transaction);
      const authority = invocation.authority ?? source.ingress?.authority ??
        source.ancestors.find((entry) => entry.ingress?.authority)?.ingress
          ?.authority;
      if (!authority || authority.scope.namespace !== binding.scope.namespace) {
        authorizationRefused();
      }
      const actor = {
        kind: "action" as const,
        id: binding.invocation.id,
        runId: binding.invocation.runId,
      };
      const id = await digestContent(
        bytes(
          stableStringify([
            authority.scope.namespace,
            authority.scope.tenant,
            actor.runId,
            key,
          ]),
        ),
      );
      const existing = (await command.transaction.query<EffectRow>(
        `SELECT * FROM ${table} WHERE namespace=$1 AND tenant=$2 AND effect_key=$3`,
        [authority.scope.namespace, authority.scope.tenant, id],
      )).rows[0];
      if (existing) {
        if (
          existing.method !== method ||
          stableStringify(existing.intent) !== stableStringify(input) ||
          existing.initiator !== identity(authority)
        ) authorizationRefused();
        return;
      }
      const object = input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      const age = method === "flow.start"
        ? object.maxAge ?? 300
        : object.maxAge;
      if (
        method !== "session.revoke" &&
        (typeof age !== "number" || !Number.isSafeInteger(age) || age <= 0 ||
          age > (method === "flow.start" ? 900 : 31536000))
      ) throw new TypeError("Invalid credential lifetime.");
      const expiresAt = new Date(
        Date.parse(command.commandTime) +
          (typeof age === "number" ? age : 0) * 1000,
      ).toISOString();
      let claims: CredentialClaims = {
        type: "clear",
        id,
        schema: options.schema,
        namespace: authority.scope.namespace,
        tenant: authority.scope.tenant,
        principal: authority.principal.id,
        expiresAt,
      };
      if (
        method !== "session.revoke" &&
        !authority.scope.bindings["@credential-proof"]
      ) authorizationRefused();
      if (method === "session.create") {
        if (
          typeof object.principal !== "string" || !object.principal.trim() ||
          Object.keys(object).some((k) => !["principal", "maxAge"].includes(k))
        ) throw new TypeError("Invalid session effect.");
        claims = { ...claims, type: "session", principal: object.principal };
        await options.create(
          authority,
          { id, principal: claims.principal, expiresAt },
          command,
          actor,
        );
        await signingKey(command, true);
      } else if (method === "session.revoke") {
        if (input !== null && typeof input !== "string") {
          throw new TypeError("Invalid session revocation.");
        }
        const target = typeof input === "string"
          ? input
          : authority.authorityBasis.kind === "session"
          ? authority.authorityBasis.id
          : undefined;
        if (!target) authorizationRefused();
        await options.revoke(authority, target, command, actor);
        claims = {
          ...claims,
          id: target,
          expiresAt: authority.validity.kind === "credential"
            ? authority.validity.expiresAt
            : command.commandTime,
        };
      } else {
        if (
          typeof object.kind !== "string" || !object.kind.trim() ||
          object.kind.length > 128 || typeof object.continuation !== "string" ||
          !options.actions[object.continuation] ||
          Object.keys(object).some((k) =>
            !["kind", "continuation", "maxAge"].includes(k)
          )
        ) throw new TypeError("Invalid flow effect.");
        const decision = await options.evaluate(authority, {
          kind: "flow",
          resource: object.kind,
          operation: "start",
          input: object,
          invocation: actor,
        }, command);
        if (!decision.constraints.flows?.start?.includes(object.kind)) {
          authorizationRefused();
        }
        claims = {
          ...claims,
          type: "flow",
          principal: id,
          kind: object.kind,
          continuation: object.continuation,
          actionId: options.actions[object.continuation].id,
        };
        await signingKey(command, true);
      }
      await command.transaction.query(
        `INSERT INTO ${table}(namespace,tenant,effect_key,run_id,operation_id,initiator,method,intent,claims) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [
          authority.scope.namespace,
          authority.scope.tenant,
          id,
          actor.runId,
          source.ancestors[0]?.event.id ?? source.event.id,
          identity(authority),
          method,
          JSON.stringify(input),
          JSON.stringify(claims),
        ],
      );
    },
    async project(
      authority: AuthenticatedAuthority,
      operationId: string,
    ): Promise<readonly CredentialProjection[]> {
      return await run(
        "authorization.credential.project",
        { operationId },
        async (_, command) => {
          await options.authorizeProjection(authority, operationId, command);
          if (
            authority.validity.kind === "credential" &&
            Date.parse(authority.validity.expiresAt) <=
              Date.parse(command.commandTime)
          ) authorizationRefused();
          const rows = (await command.transaction.query<EffectRow>(
            `SELECT * FROM ${table} WHERE namespace=$1 AND tenant=$2 AND operation_id=$3 ORDER BY ordinal`,
            [
              authority.scope.namespace,
              authority.scope.tenant,
              operationId,
            ],
          )).rows;
          const output: CredentialProjection[] = [];
          for (const row of rows) {
            const original = JSON.parse(row.initiator) as {
              proof?: string;
              basis: AuthenticatedAuthority["authorityBasis"];
            };
            const own = row.initiator === identity(authority) ||
              (row.claims.type === "clear" && !!original.proof &&
                original.proof ===
                  authority.scope.bindings["@credential-proof"]) ||
              (row.claims.type === "session" &&
                authority.authorityBasis.kind === "session" &&
                authority.authorityBasis.id === row.claims.id) ||
              (row.claims.type === "flow" &&
                authority.flow?.id === row.claims.id);
            if (
              !own ||
              Date.parse(row.claims.expiresAt) <=
                Date.parse(command.commandTime)
            ) continue;
            if (row.claims.type === "clear") {
              // Revoking another session must not sign the caller out.
              if (
                original.basis.kind === "session" &&
                original.basis.id === row.claims.id
              ) {
                output.push({ claims: row.claims });
              }
              continue;
            }
            if (row.claims.type === "session") {
              const live = await command.transaction.query(
                `SELECT 1 FROM "${options.schema}".authorization_sessions WHERE namespace=$1 AND tenant=$2 AND id=$3 AND revoked_at IS NULL AND expires_at>$4::timestamptz`,
                [
                  row.claims.namespace,
                  row.claims.tenant,
                  row.claims.id,
                  command.commandTime,
                ],
              );
              if (!live.rows.length) continue;
            }
            output.push({
              claims: row.claims,
              token: await tokenFor(row.claims, command),
            });
          }
          return output;
        },
      );
    },
    async authenticate(
      selected: AuthenticatedAuthority,
      token: string,
      type: "session" | "flow",
    ): Promise<AuthenticatedAuthority> {
      return await run(
        "authorization.credential.authenticate",
        {},
        async (_, command) => {
          try {
            if (token.length > 8192) authorizationRefused();
            const parts = token.split(".");
            if (parts.length !== 2) authorizationRefused();
            const [payload, signature] = parts;
            if (
              !await crypto.subtle.verify(
                "HMAC",
                await signingKey(command, false),
                decode(signature),
                bytes(`copilotz.credential.v1.${payload}`),
              )
            ) authorizationRefused();
            const claims = JSON.parse(
              new TextDecoder().decode(decode(payload)),
            ) as CredentialClaims;
            if (
              claims.type !== type || claims.schema !== options.schema ||
              claims.namespace !== selected.scope.namespace ||
              claims.tenant !== selected.scope.tenant ||
              Date.parse(claims.expiresAt) <= Date.parse(command.commandTime)
            ) authorizationRefused();
            return retainedAuthority({
              ...selected,
              principal: {
                kind: type === "session" ? "session" : "grant",
                id: claims.principal,
              },
              authorityBasis: {
                kind: type === "session" ? "session" : "grant",
                id: claims.id,
              },
              validity: credentialValidity(
                new Date(command.commandTime),
                claims.expiresAt,
              ),
              ...(type === "flow"
                ? {
                  flow: {
                    id: claims.id,
                    kind: claims.kind,
                    continuation: claims.continuation,
                    expiresAt: claims.expiresAt,
                  },
                }
                : {}),
            });
          } catch {
            authorizationRefused();
          }
        },
      );
    },
  };
}
