/**
 * An app's host (`<label>.<domain>`) in the directory, which the front (the
 * Cloudflare worker) asks where to send each host's requests: claimed with
 * no target when the app is recorded (it's building: its label is held, and
 * nothing routes there yet), claimed again with its target once it's live
 * (the front then sends the host straight to its service), and released
 * when it's removed. An org's runtime reaches the directory through the
 * orgs host's `directory` resource; a single runtime (development) has
 * none, claims nothing, and its own records keep labels apart.
 *
 * `claimHost` refuses (`forbidden`) another org's host, and the app's own.
 */
import type { Resources } from "../../../../runtime/mod.ts";
import { codeOf } from "./errors.ts";

/** What the apps plugin uses of the directory's resource. */
export type HostClaims = {
  claimHost?(host: string, claim?: { target?: string }): Promise<void>;
  releaseHost?(host: string): Promise<void>;
};

const claimsOf = (ctx: { resources: Resources }) =>
  ctx.resources.directory as HostClaims | undefined;

/** Claims `host` (routing it to `target`, when given); false when it's someone else's. */
export async function claim(
  ctx: { resources: Resources },
  host: string,
  target?: string,
): Promise<boolean> {
  try {
    await claimsOf(ctx)?.claimHost?.(host, target ? { target } : {});
    return true;
  } catch (error) {
    if (codeOf(error) === "forbidden") return false;
    throw error;
  }
}

/** Lets `host` go: nothing routes there any more. */
export async function release(ctx: { resources: Resources }, host: string): Promise<void> {
  await claimsOf(ctx)?.releaseHost?.(host);
}
