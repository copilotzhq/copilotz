import type { ContentValue } from "@copilotz/copilotz/content";
import type { PluginRegistry } from "@copilotz/copilotz/plugins";
import {
  createTextRenderer,
  createViewResolver,
  snapshotViewData,
  type TextRendererOptions,
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
 * Only the explicitly authorized public projection enters this presentation.
 * Records may contain protected fields, but the projector must omit those fields
 * and protected-derived text. Prompt instructions are ordinary captured data.
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
    /** Private host bounds; admission is shared across contributions/scopes. */
    limits?: Pick<
      TextRendererOptions,
      "maxDepth" | "maxNodes" | "maxBytes" | "maxPending" | "timeoutMs"
    >;
  }>,
): ContextContributionRenderer {
  if (typeof options.project !== "function") {
    throw new TypeError("An authorized Context View projection is required.");
  }
  const project = options.project;
  const resolveView = options.registry.resolveView.bind(options.registry);
  const limits = snapshotViewData(options.limits ?? {}) as NonNullable<
    typeof options.limits
  >;
  const resources = snapshotViewData(
    options.resources ?? {},
    limits,
  ) as ViewContext["resources"];
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
  const maxPending = limits.maxPending ?? 16;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError("Invalid Context View pending bound.");
  }
  let pending = 0;
  return async (input) => {
    input.signal.throwIfAborted();
    if (!Object.hasOwn(bindings, input.contribution.resourceId)) {
      return undefined;
    }
    if (pending >= maxPending) {
      throw new RangeError("Context View pending capacity exceeded.");
    }
    pending++;
    let physical = 0;
    let finished = false;
    let released = false;
    const release = () => {
      if (finished && physical === 0 && !released) {
        released = true;
        pending--;
      }
    };
    // A renderer has a per-scope lifetime. Keep this helper's admission across
    // those instances until original project/View work, not abort races, settles.
    const track = <T>(invoke: () => T | Promise<T>): Promise<T> => {
      physical++;
      let work: Promise<T>;
      try {
        work = Promise.resolve(invoke());
      } catch (error) {
        work = Promise.reject(error);
      }
      const settled = () => {
        physical--;
        release();
      };
      work.then(settled, settled);
      return work;
    };
    try {
      const renderer = createTextRenderer({
        ...limits,
        registry: {
          resolveView(shows, mode, renderer) {
            const view = resolveView(shows, mode, renderer);
            const renderView = view?.render;
            return view
              ? {
                ...view,
                render: (value: never, context: ViewContext) =>
                  track(() => renderView!.call(view, value, context)),
              }
              : undefined;
          },
        },
        scope: input.scope,
        resources,
        project: (reference, context) =>
          track(() =>
            project({
              ...input,
              reference,
              scope: context.scope as ContextViewScope,
              signal: context.signal,
            })
          ),
      });
      return await renderer.render(
        {
          shows: bindings[input.contribution.resourceId],
          value: input.content,
        },
        { mode: "context", renderer: "text" },
        input.signal,
      );
    } finally {
      finished = true;
      release();
    }
  };
}
