/** View primitive: portable authoring, composition resolution and pure text rendering. @module */
export { defineView, isViewDefinition } from "./definition.ts";
export type {
  AnyViewDefinition,
  ViewActions,
  ViewCollections,
  ViewContext,
  ViewDefinition,
  ViewEnvironment,
  ViewHints,
  ViewMap,
  ViewRead,
  ViewReference,
  ViewShows,
} from "./definition.ts";
export { createViewResolver } from "./resolution.ts";
export type { ViewPreference } from "./resolution.ts";
export { createTextRenderer, snapshotViewData } from "./renderer.ts";
export type {
  OneShotViewRenderer,
  TextRendererOptions,
  TextViewRenderer,
  ViewRendererAdapter,
} from "./renderer.ts";
