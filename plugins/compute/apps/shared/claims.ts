/**
 * An app's host (`<label>.<domain>`) in the directory, which the front (the
 * Cloudflare worker) asks where to send each host's requests: claimed when
 * the app is recorded (no target yet: it's building), claimed again with
 * its target once it's live, released when it's removed. An org's runtime
 * reaches the directory through the orgs host's `directory` resource; an
 * app with no directory (one runtime, development) claims nothing, and
 * its own records keep labels apart.
 *
 * A host another org holds is taken: `claimHost` throws with a code saying
 * so (`taken`, `conflict`, `exists`), or answers false.
 */
import type { Resources } from "../../../../runtime/mod.ts";
import { codeOf } from "./errors.ts";

/** What the apps plugin uses of the directory's resource. */
export type HostClaims = {
  claimHost?(host: string, options?: { target?: string }): Promise<unknown>;
  releaseHost?(host: string): Promise<unknown>;
};

const TAKEN = new Set(["taken", "conflict", "exists", "already_exists", "host_taken"]);

const claimsOf = (ctx: { resources: Resources }) =>
  ctx.resources.directory as HostClaims | undefined;

/** Claims `host` (routing it to `target`, when given); false when another holds it. */
export async function claim(
  ctx: { resources: Resources },
  host: string,
  target?: string,
): Promise<boolean> {
  const claims = claimsOf(ctx);
  if (!claims?.claimHost) return true;
  try {
    const said = await claims.claimHost(host, target ? { target } : {});
    const refused = said === false ||
      (typeof said === "object" && said !== null &&
        ((said as { claimed?: unknown }).claimed === false ||
          (said as { ok?: unknown }).ok === false));
    return !refused;
  } catch (error) {
    if (TAKEN.has(codeOf(error) ?? "")) return false;
    throw error;
  }
}

/** Lets `host` go: nothing routes there any more. */
export async function release(ctx: { resources: Resources }, host: string): Promise<void> {
  await claimsOf(ctx)?.releaseHost?.(host);
}
