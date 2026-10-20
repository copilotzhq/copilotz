/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** One View body in every density: dialog header inside the dialog host, Screen elsewhere. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import React from "react";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/dialog.tsx";

export function Frame(
  { ctx, title, description, actions, children }: {
    ctx: BrowserViewContext;
    title: string;
    description?: string;
    actions?: React.ReactNode;
    children?: React.ReactNode;
  },
): React.ReactElement {
  if (ctx.hints.mode === "dialog") {
    return (
      <div data-density="dialog" className="grid gap-4">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {actions}
        {children}
      </div>
    );
  }
  return (
    <Screen title={title} density={ctx.hints.mode} actions={actions}>
      {description && (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
      {children}
    </Screen>
  );
}

import { Screen } from "./patterns.tsx";
