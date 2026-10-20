import type React from "react";
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
  Screen,
} from "@copilotz/copilotz/web/kit";
function Navigator({ ctx }: { ctx: BrowserViewContext }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  useEffect(() => {
    const handler = (event: Event) => {
      const keyEvent = event as Event & {
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
export default defineView<unknown, React.ReactNode, BrowserViewContext>({
  id: "ui.workspace",
  shows: "workspace",
  renderer: "react",
  modes: ["full", "panel"],
  render(_item, ctx) {
    const workspace = ctx.collections.workspace.get("main").value;
    const focus = workspace?.focus as ViewReference | null;
    const context = workspace?.context as ViewReference | null;
    return (
      <Screen title="Workspace" density={ctx.hints.mode}>
        <Navigator ctx={ctx} />
        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <main>
            {focus
              ? ctx.show(focus, { mode: "full" }) as React.ReactNode
              : <p>Select a view to get started.</p>}
          </main>
          {context && (
            <aside aria-label="Context">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  aria-label="Swap focus and context"
                  onClick={() => ctx.actions.uiSwap({})}
                >
                  ⇄
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => ctx.actions.uiClose({ region: "context" })}
                >
                  Close
                </Button>
              </div>
              {ctx.show(context, { mode: "panel" }) as React.ReactNode}
            </aside>
          )}
        </div>
      </Screen>
    );
  },
});
