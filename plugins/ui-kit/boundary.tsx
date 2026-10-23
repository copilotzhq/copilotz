/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Contain View and component failures to the pane that produced them. @module */
import React from "react";
import type { ViewHints, ViewReference } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { Notice } from "./components/feedback.tsx";

export class PaneBoundary extends React.Component<
  { children?: React.ReactNode; label: string },
  { error: string | null }
> {
  override state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Notice tone="error" title={`${this.props.label} failed to render`}>
          {this.state.error}
        </Notice>
      );
    }
    return this.props.children;
  }
}

/** Render a nested View; a resolution or render failure becomes a notice. */
export function showSafely(
  ctx: BrowserViewContext,
  reference: ViewReference,
  hints: ViewHints,
  label = "This view",
): React.ReactNode {
  try {
    return (
      <PaneBoundary key={JSON.stringify(reference)} label={label}>
        {ctx.show(reference, hints) as React.ReactNode}
      </PaneBoundary>
    );
  } catch (error) {
    return (
      <Notice tone="error" title={`${label} is unavailable`}>
        {error instanceof Error ? error.message : String(error)}
      </Notice>
    );
  }
}
