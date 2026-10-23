import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type { HttpAdapter } from "../plugins/server/authoring/http-adapter/index.ts";

/** Only composed, trusted adapters contribute domain-specific ingress metadata. */
export function httpIngressMetadata(
  application: InternalCopilotzApplication,
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.assign(
    {},
    ...Object.values(application.plugins.adapters.http ?? {})
      .map((adapter) =>
        (adapter as HttpAdapter).ingressMetadata?.(metadata) ?? {}
      ),
  );
}
