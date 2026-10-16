import type { ContentValue } from "@copilotz/copilotz/content";
import type { PluginRegistry } from "@copilotz/copilotz/plugins";
import {
  createTextRenderer,
  createViewResolver,
  snapshotViewData,
  type ViewContext,
  type ViewReference,
  type ViewShows,
} from "@copilotz/copilotz/views";
import { isContextResource } from "../../../authoring/define-context/index.ts";
import type { CollectedContextContribution } from "../../../shared/contributions.ts";

/** Identity selectors only. The host must authorize them against the admitted
 * executing context and current policy; contribution metadata grants nothing. */
type ContextViewScope = Readonly<{
  namespace: string;
  agentId: string;
  participantId: string;
  threadId: string;
}>;

type ContextViewInput = Readonly<{
  contribution: CollectedContextContribution;
  content: ContentValue;
  scope: ContextViewScope;
  signal: AbortSignal;
}>;

/** Private prompt-preparation seam, deliberately absent from public contexts. */
export type ContextContributionRenderer = (
  input: ContextViewInput,
) => string | undefined | Promise<string | undefined>;

/** Bind trusted, registered Context resource IDs to presentation kinds. This
 * helper does not infer references or authority from contribution contents.
 * Projection is mandatory for every render, including nested/generic renders.
 * Only ordinary authorized plain values are supported: the host must exclude
 * hidden/protected fields and protected-derived text before returning a value.
 * Plain prompt instructions become ordinary callLlm receipt data, not secrets.
 */
export function createContextViewRenderer(
  options: Readonly<{
    registry: Pick<PluginRegistry, "resources" | "resolveView">;
    bindings: Readonly<Record<string, ViewShows>>;
    project(
      input: ContextViewInput & Readonly<{ reference: ViewReference }>,
    ): unknown | Promise<unknown>;
    /** Explicitly host-approved inert presentation resources, never the complete
     * registry (which can contain secrets and executable capabilities). */
    resources?: ViewContext["resources"];
  }>,
): ContextContributionRenderer {
  if (typeof options.project !== "function") {
    throw new TypeError("An authorized Context View projection is required.");
  }
  const bindings = snapshotViewData(
    options.bindings,
  ) as typeof options.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new TypeError("Context View bindings must be a resource-ID map.");
  }
  const registered = Object.values(
    options.registry.resources.promptContext ?? {},
  )
    .filter(isContextResource);
  // The public resolver validates reference syntax even with no candidates.
  // Validation must not require a matching View: authorized fallback is valid.
  const validateReference = createViewResolver({});
  for (const [resourceId, shows] of Object.entries(bindings)) {
    if (
      registered.filter((resource) => resource.id === resourceId).length !== 1
    ) {
      throw new TypeError(
        `Context View binding '${resourceId}' requires one registered Context resource.`,
      );
    }
    validateReference(shows, "context", "text");
  }
  return async (input) => {
    input.signal.throwIfAborted();
    if (!Object.hasOwn(bindings, input.contribution.resourceId)) {
      return undefined;
    }
    const renderer = createTextRenderer({
      registry: options.registry,
      scope: input.scope,
      resources: options.resources,
      project: (reference, context) =>
        options.project({
          ...input,
          reference,
          scope: context.scope as ContextViewScope,
          signal: context.signal,
        }),
    });
    return await renderer.render(
      {
        shows: bindings[input.contribution.resourceId],
        value: input.content,
      },
      { mode: "context", renderer: "text" },
      input.signal,
    );
  };
}
