export { createCopilotzEngine } from "./engine.ts";
export type {
  CopilotzEngine,
  CopilotzEngineDatabaseScope,
  CopilotzEngineDispatchReport,
  CopilotzEngineExecutionOptions,
  CopilotzEngineMaintenanceResult,
  CopilotzEnginePublishAssetInput,
  CreateCopilotzEngineOptions,
  EphemeralEventInput,
} from "./types.ts";

// Low-level ingress definitions shared by the application and Server composition.
export * from "../application/ingress/contracts.ts";
export { serverActionRequestProcessor } from "../application/ingress/action-request.ts";
export { serverCollectionMutationRequestProcessor } from "../application/ingress/collection-mutation-request.ts";
export {
  createInputSchema,
  updateInputSchema,
} from "../application/ingress/mutation-schema.ts";

// Retained authority data and offline migration inventory; data alone grants nothing.
export type {
  ServerCollectionMutationConstraints,
  ServerCollectionMutationPolicy,
  ServerConstraints,
} from "../authorization/contracts.ts";
export {
  AUTHORITY_ADMISSION_MS,
  credentialValidity,
  retainedAuthority,
} from "../authorization/authority.ts";
export type {
  AuthenticatedAuthority,
  AuthorityDependency,
  AuthorityPolicy,
  AuthorityPrincipal,
  AuthorityScope,
  AuthorityValidity,
} from "../authorization/authority.ts";
export {
  planAuthorityMigration,
  retainedInvocationDigest,
} from "../authorization/migration.ts";
export type {
  AuthorityMigrationEntry,
  MigratedInvocationAuthority,
  RetainedInvocation,
} from "../authorization/migration.ts";

export type {
  AuthorizationDecision,
  AuthorizationIntent,
  AuthorizationRead,
  OwnerAuthorization,
  OwnerPolicy,
} from "../authorization/evaluator.ts";
export type {
  AuthorizationSource,
  StaffAuthorizationSource,
} from "../authorization/directory.ts";
export { createDatabaseStaffSource } from "../authorization/directory.ts";
export { defineDatabaseDirectoryRead } from "../authorization/directory-read.ts";
export type {
  DatabaseDirectoryRead,
  DirectoryReader,
} from "../authorization/directory-read.ts";

export {
  inspectAuthorityUpgrade,
  upgradeAuthoritySchema,
} from "../authorization/upgrade.ts";
export type { AuthorityUpgradeManifest } from "../authorization/upgrade.ts";
export { withRetainedAuthority } from "../authorization/binding.ts";

export {
  defineIdentityVerifier,
  pruneIdentityEvidence,
} from "../authorization/identity-evidence.ts";
export type {
  IdentityEvidence,
  IdentityEvidenceReader,
  IdentityVerifier,
  IdentityVerifierClient,
} from "../authorization/identity-evidence.ts";

export { defineDatabaseDirectoryCommand } from "../authorization/directory-command.ts";
export type {
  DatabaseDirectoryCommand,
  DirectoryCommandContext,
  DirectoryCommands,
  TransactionDirectoryCommands,
} from "../authorization/directory-command.ts";
