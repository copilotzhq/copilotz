/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect, useState } from "react";
import { defineView, type ViewReference } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
} from "@copilotz/copilotz/web/kit";
function Navigator({ ctx }: { ctx: BrowserViewContext }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  useEffect(() => {
    const handler = (event: { preventDefault(): void }) => {
      const keyEvent = event as {
        preventDefault(): void;
        metaKey: boolean;
        ctrlKey: boolean;
        key: string;
      };
      if ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    globalThis.addEventListener("keydown", handler);
    return () => globalThis.removeEventListener("keydown", handler);
  }, []);
  const entries = Object.entries(ctx.resources.navigation ?? {}) as [
    string,
    ViewReference & { label: string },
  ][];
  const links = (palette: boolean) =>
    entries.filter(([, entry]) =>
      !palette || entry.label.toLowerCase().includes(search.toLowerCase())
    ).map(([id, entry]) => (
      <Button
        key={id}
        variant="ghost"
        onClick={() => {
          ctx.actions.uiOpen({
            reference: { shows: entry.shows, value: entry.value },
            source: palette ? "command" : "navigator",
          });
          setOpen(false);
        }}
      >
        {entry.label}
      </Button>
    ));
  return (
    <nav aria-label="Navigation" className="flex flex-wrap gap-2">
      {links(false)}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline">Search ⌘K</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open a view</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Find a view"
            value={search}
            onChange={(event) =>
              setSearch((event.target as unknown as { value: string }).value)}
          />
          <div className="flex flex-col">{links(true)}</div>
        </DialogContent>
      </Dialog>
    </nav>
  );
}
const view: import("@copilotz/copilotz/views").ViewDefinition<
  unknown,
  React.ReactNode,
  BrowserViewContext
> = defineView<unknown, React.ReactNode, BrowserViewContext>({
  id: "ui.navigator",
  shows: "workspaceNavigator",
  renderer: "react",
  modes: ["full", "panel"],
  render(_item, ctx) {
    return <Navigator ctx={ctx} />;
  },
});

export default view;
