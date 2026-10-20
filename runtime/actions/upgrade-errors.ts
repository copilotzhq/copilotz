/** Missing operator input at a durable offline upgrade checkpoint. */
export class UpgradeStepRequiredError extends Error {
  constructor(
    readonly code:
      | "copilotz_upgrade_owner_keys_required"
      | "copilotz_upgrade_authority_required",
    readonly fromVersion: number,
    readonly toVersion: number,
    message: string,
  ) {
    super(message);
    this.name = "UpgradeStepRequiredError";
  }
}
export function ownerKeysRequired(): UpgradeStepRequiredError {
  return new UpgradeStepRequiredError(
    "copilotz_upgrade_owner_keys_required",
    11,
    12,
    "Next step: offline owner-key migration v11 -> v12 requires sourceAdapter and masterAdapter (ownerKeys).",
  );
}
export function authorityRequired(): UpgradeStepRequiredError {
  return new UpgradeStepRequiredError(
    "copilotz_upgrade_authority_required",
    12,
    13,
    "Next step: authority migration v12 -> v13 requires a reviewed authority manifest (authority).",
  );
}
