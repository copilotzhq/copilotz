/** Credential-free plans accepted by the owner transaction. */
export type ActionSessions = Readonly<{
  /** Account principal and lifetime in seconds (at most one year). No token is returned. */
  create(input: Readonly<{ principal: string; maxAge: number }>): Promise<void>;
  /** Defaults to this invocation's session. Cookie clearing applies only to self-revocation. */
  revoke(id?: string): Promise<void>;
}>;
export type ActionFlows = Readonly<{
  start(
    input: Readonly<{
      kind: string;
      /** Registered continuation Action alias. */
      continuation: string;
      /** Seconds, at most fifteen minutes. Defaults to five minutes. */
      maxAge?: number;
    }>,
  ): Promise<void>;
}>;
export type CredentialEffectMethod =
  | "session.create"
  | "session.revoke"
  | "flow.start";
