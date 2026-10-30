/** Failures as Actions throw them (a message, and a code callers tell apart), and their words. */

export const failure = (message: string, code = "failed"): Error =>
  Object.assign(new Error(message), { code });

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const codeOf = (error: unknown): string | undefined =>
  (error as { code?: unknown } | undefined)?.code as string | undefined;
