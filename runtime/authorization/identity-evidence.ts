/** Owner-only identity verification. Persisted worker results are never evidence. */
import type { AuthenticatedAuthority } from "./authority.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { stableStringify } from "../collections/equal.ts";
import { digestContent } from "../content/digest.ts";
import { captureCollectionInvocation } from "./invocation.ts";
import {
  createSchemaCommandRunner,
  currentOwnerCommand,
} from "../engine/commands.ts";
import { withOwnerAuthorizationPhase } from "../engine/command-authorization.ts";
import {
  authorizationRefused,
  createOwnerEvaluator,
  type OwnerAuthorization,
} from "./evaluator.ts";
import type { CollectionDefinition } from "../collections/definition.ts";

export type IdentityEvidence = Readonly<{
  issuer: string;
  subject: string;
  principal: string;
  claims?: Readonly<Record<string, unknown>>;
}>;
export type IdentityEvidenceReader = Readonly<{
  get(alias: string): Promise<IdentityEvidence | null>;
}>;
export type IdentityVerifier = Readonly<{
  revision: string;
  actions: readonly string[];
  verify(
    input: unknown,
    context: Readonly<{
      binding: IdentityEvidenceBinding;
      exchangeKey: string;
      signal: AbortSignal;
    }>,
  ): Promise<IdentityEvidence>;
}>;
export type IdentityEvidenceBinding = Readonly<{
  databaseSchema: string;
  namespace: string;
  tenant: string;
  flow: string;
  operationId: string;
  proof: string;
  expiresAt: string;
}>;
export type IdentityVerifierClient = Readonly<{
  verify(alias: string, input: unknown): Promise<IdentityEvidence>;
}>;
export type OwnerCapabilityOptions = Readonly<{
  session: SqlSession;
  databaseSchema: string;
  registration?: OwnerAuthorization;
  collections: Readonly<Record<string, CollectionDefinition>>;
  actions: Readonly<Record<string, { id: string }>>;
}>;
export function defineIdentityVerifier(
  value: IdentityVerifier,
): IdentityVerifier {
  if (
    !value.revision?.trim() || !value.actions?.length ||
    value.actions.some((action) => !action?.trim()) ||
    typeof value.verify !== "function"
  ) {
    throw new TypeError("Invalid identity verifier declaration.");
  }
  return Object.freeze({
    ...value,
    actions: Object.freeze([...value.actions]),
  });
}
export async function identityEvidenceBinding(
  authority: AuthenticatedAuthority,
  command: { transaction: SqlExecutor; commandTime: string },
): Promise<IdentityEvidenceBinding> {
  const flow = authority.flow;
  const scope = authority.scope;
  const proof = scope.bindings["@credential-proof"];
  if (
    !flow || !proof ||
    Date.parse(flow.expiresAt) <= Date.parse(command.commandTime)
  ) authorizationRefused();
  const row = (await command.transaction.query<{
    accepted_operation: string;
    consumed_run: string;
    initiator: string;
    claims: { expiresAt: string; kind: string; continuation: string };
  }>(
    `SELECT accepted_operation,consumed_run,initiator,claims FROM "${scope.databaseSchema}".authorization_effects
    WHERE namespace=$1 AND tenant=$2 AND effect_key=$3 AND method='flow.start'`,
    [scope.namespace, scope.tenant, flow.id],
  )).rows[0];
  if (
    !row?.accepted_operation || !row.consumed_run ||
    row.claims.expiresAt !== flow.expiresAt ||
    row.claims.kind !== flow.kind ||
    row.claims.continuation !== flow.continuation ||
    JSON.parse(row.initiator).proof !== proof
  ) authorizationRefused();
  return {
    databaseSchema: scope.databaseSchema,
    namespace: scope.namespace,
    tenant: scope.tenant,
    flow: flow.id,
    operationId: row.accepted_operation,
    proof,
    expiresAt: flow.expiresAt,
  };
}
const digest = (value: unknown) =>
  digestContent(new TextEncoder().encode(stableStringify(value)));
const keyFor = async (binding: IdentityEvidenceBinding, alias: string) =>
  `identity.evidence:${await digest({ binding, alias })}`;
export async function readIdentityEvidence(
  registration: OwnerAuthorization,
  authority: AuthenticatedAuthority,
  alias: string,
  command: { transaction: SqlExecutor; commandTime: string },
): Promise<IdentityEvidence | null> {
  const declaration = Object.hasOwn(registration.identityVerifiers ?? {}, alias)
    ? registration.identityVerifiers![alias]
    : undefined;
  if (!declaration) authorizationRefused();
  if (!authority.flow) return null;
  const binding = await identityEvidenceBinding(authority, command);
  const row = (await command.transaction.query<{
    intent: { revision: string };
    result: { state: string; evidence?: IdentityEvidence };
  }>(
    `SELECT intent,result FROM "${binding.databaseSchema}".owner_receipts
      WHERE owner='schema' AND domain='logical' AND kind='identity.evidence' AND key=$1`,
    [await keyFor(binding, alias)],
  )).rows[0];
  if (!row) return null;
  if (row.intent.revision !== declaration.revision) authorizationRefused();
  return row.result.state === "verified" && row.result.evidence
    ? captureHostCommandJson(row.result.evidence) as IdentityEvidence
    : null;
}
export function createIdentityVerifierClient(
  options: OwnerCapabilityOptions,
): IdentityVerifierClient {
  const run = createSchemaCommandRunner(
    options.session,
    options.databaseSchema,
  );
  const evaluate = options.registration &&
    createOwnerEvaluator({ ...options, registration: options.registration });
  return {
    async verify(alias, value) {
      if (currentOwnerCommand()) {
        throw new Error(
          "Identity verification must run outside a transaction.",
        );
      }
      const invocation = captureCollectionInvocation();
      const declarations = options.registration?.identityVerifiers;
      const declaration = declarations && Object.hasOwn(declarations, alias)
        ? declarations[alias]
        : undefined;
      const action = Object.entries(options.actions).find(([, a]) =>
        a.id === invocation?.invocation.id
      )?.[0];
      if (
        !invocation?.authority || invocation.invocation.kind !== "action" ||
        !evaluate ||
        invocation.scope.databaseSchema !== options.databaseSchema ||
        !declaration || !action ||
        !declaration.actions.includes(action)
      ) authorizationRefused();
      invocation.check();
      const input = captureHostCommandJson(value);
      if (new TextEncoder().encode(stableStringify(input)).length > 16384) {
        authorizationRefused();
      }
      const inputDigest = await digest(input);
      const check = async (
        command: Parameters<typeof identityEvidenceBinding>[1],
      ) => {
        invocation.check();
        await invocation.assertCurrent?.(command, invocation.invocation);
        const decision = await evaluate(invocation.authority!, {
          kind: "identity",
          resource: alias,
          operation: "verify",
          input: { inputDigest },
          invocation: invocation.invocation,
        }, { ...command, signal: invocation.signal });
        if (
          !Array.isArray(decision.constraints.identityVerifiers) ||
          !decision.constraints.identityVerifiers.includes(alias)
        ) authorizationRefused();
        const binding = await identityEvidenceBinding(
          invocation.authority!,
          command,
        );
        if (
          binding.operationId !== invocation.operationId
        ) authorizationRefused();
        return binding;
      };
      const reservation = await run(
        "identity.reserve",
        { alias, inputDigest },
        async (_, command) => {
          const binding = await check(command);
          const key = await keyFor(binding, alias);
          const table = `"${options.databaseSchema}".owner_receipts`;
          const row = (await command.transaction.query<
            {
              intent: { inputDigest: string; revision: string };
              result: { state: string; evidence?: IdentityEvidence };
            }
          >(
            `SELECT intent,result FROM ${table} WHERE owner='schema' AND domain='logical' AND key=$1`,
            [key],
          )).rows[0];
          if (row) {
            if (
              row.intent.inputDigest !== inputDigest ||
              row.intent.revision !== declaration.revision
            ) authorizationRefused();
            if (row.result.state !== "verified" || !row.result.evidence) {
              throw Object.assign(
                new Error(
                  "Identity exchange is pending or its outcome is unknown. Start a new flow.",
                ),
                { code: "identity_evidence_pending" },
              );
            }
            return { key, binding, evidence: row.result.evidence };
          }
          await command.transaction.query(
            `INSERT INTO ${table}(owner,domain,key,principal,kind,intent,result)
        VALUES('schema','logical',$1,$2,'identity.evidence',$3::jsonb,'{"state":"pending"}'::jsonb)`,
            [
              key,
              invocation.authority!.principal.id,
              JSON.stringify({
                binding,
                alias,
                revision: declaration.revision,
                inputDigest,
              }),
            ],
          );
          return { key, binding, evidence: null };
        },
      );
      if (reservation.evidence) {
        return captureHostCommandJson(
          reservation.evidence,
        ) as IdentityEvidence;
      }
      const evidence = captureHostCommandJson(
        await withOwnerAuthorizationPhase(() =>
          declaration.verify(input, {
            binding: Object.freeze({ ...reservation.binding }),
            exchangeKey: reservation.key,
            signal: invocation.signal,
          })
        ),
      ) as IdentityEvidence;
      if (
        !evidence ||
        [evidence.issuer, evidence.subject, evidence.principal].some((s) =>
          typeof s !== "string" || !s.trim()
        ) ||
        (evidence.claims !== undefined &&
          (!evidence.claims || typeof evidence.claims !== "object" ||
            Array.isArray(evidence.claims))) ||
        Object.keys(evidence).some((k) =>
          !["issuer", "subject", "principal", "claims"].includes(k)
        ) ||
        new TextEncoder().encode(stableStringify(evidence)).length > 16384
      ) authorizationRefused();
      return await run(
        "identity.complete",
        { key: reservation.key },
        async (_, command) => {
          await check(command);
          const result = await command.transaction.query(
            `UPDATE "${options.databaseSchema}".owner_receipts
        SET result=$2::jsonb WHERE owner='schema' AND domain='logical' AND key=$1 AND result->>'state'='pending' RETURNING key`,
            [reservation.key, JSON.stringify({ state: "verified", evidence })],
          );
          if (result.rows.length !== 1) authorizationRefused();
          await command.transaction.query(
            `INSERT INTO "${options.databaseSchema}".owner_receipts(owner,domain,key,principal,kind,intent,result)
        VALUES('schema','logical',$1,$2,'identity.audit',$3::jsonb,'{}'::jsonb)`,
            [
              `${reservation.key}:audit`,
              invocation.authority!.principal.id,
              JSON.stringify({
                alias,
                revision: declaration.revision,
                bindingDigest: await digest(reservation.binding),
                operationId: reservation.binding.operationId,
                evidenceDigest: await digest(evidence),
                commandTime: command.commandTime,
              }),
            ],
          );
          return evidence;
        },
      );
    },
  };
}
/** Host maintenance only; expired flows cannot request another exchange. */
export async function pruneIdentityEvidence(
  session: SqlSession,
  databaseSchema: string,
): Promise<number> {
  if (captureCollectionInvocation()) authorizationRefused();
  return await createSchemaCommandRunner(session, databaseSchema)(
    "identity.prune",
    {},
    async (_, command) => {
      const removed = await command.transaction.query(
        `DELETE FROM "${databaseSchema}".owner_receipts
      WHERE kind='identity.evidence' AND owner='schema' AND domain='logical'
      AND (intent->'binding'->>'expiresAt')::timestamptz <= $1::timestamptz RETURNING key`,
        [command.commandTime],
      );
      return removed.rows.length;
    },
  );
}
