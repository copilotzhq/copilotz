/** Compute: computers people connect, and what agents do on them. */
export * from "./computers/mod.ts";
/** Google's tokens, without its SDKs (for Google Cloud Storage's blobs, say), and who a Compute Engine VM is. */
export {
  type ComputeEngine,
  type GoogleAuthOptions,
  googleToken,
  verifyIdentityToken,
  type VerifyOptions,
} from "./google.ts";
