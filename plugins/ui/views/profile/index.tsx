/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import * as React from "react";
import { Brain, Mail } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Avatar,
  AvatarFallback,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  formatRelative,
  initials,
  ReadStatus,
} from "@copilotz/copilotz/web/kit";

/**
 * The signed-in person and what agents remember. Memories are the Memory
 * plugin's personal notes, constrained by the authenticated owner policy.
 */
const view: ViewDefinition<unknown, React.ReactNode, BrowserViewContext> =
  defineView<unknown, React.ReactNode, BrowserViewContext>({
    id: "ui.userProfile",
    shows: "userProfile",
    renderer: "react",
    modes: ["dialog", "full", "panel"],
    render(_value, ctx) {
      const sender = ((ctx.resources.chat as Record<string, unknown>)
        ?.sender ?? {}) as Record<string, unknown>;
      const name = String(sender.name ?? sender.email ?? "You");
      const email = typeof sender.email === "string" ? sender.email : undefined;
      const participantId = typeof sender.id === "string"
        ? sender.id
        : typeof sender.externalId === "string"
        ? ctx.collections.participant?.list({
          where: { externalId: sender.externalId, participantType: "human" },
          limit: 1,
        }).value[0]?.id
        : undefined;
      const notes = participantId
        ? ctx.collections.memoryNote?.list({
          where: { memorySpaceId: `memory-space:personal:${participantId}` },
          filter: { field: "retirement", eq: null },
          order: { field: "id", direction: "desc" },
          limit: 100,
        })
        : undefined;
      const active = notes?.value.filter((note) => !note.retirement) ?? [];
      return (
        <div className="grid gap-5">
          <MemoryImport ctx={ctx} participantId={participantId} />
          <DialogHeader>
            <DialogTitle>Profile</DialogTitle>
            <DialogDescription>
              Who you are to the agents in this app.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <Avatar className="size-12 rounded-xl">
              <AvatarFallback className="bg-primary/10 rounded-xl text-base font-semibold">
                {initials(name)}
              </AvatarFallback>
            </Avatar>
            <div className="grid min-w-0">
              <p className="truncate font-semibold">{name}</p>
              {email && (
                <p className="text-muted-foreground flex items-center gap-1.5 truncate text-sm">
                  <Mail aria-hidden="true" className="size-3.5" /> {email}
                </p>
              )}
            </div>
          </div>
          {notes && (
            <section aria-label="Memories" className="grid gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Brain aria-hidden="true" className="size-4" /> Memories
              </h3>
              <p className="text-muted-foreground text-xs">
                Facts and preferences agents remember about you across
                conversations.
              </p>
              {notes.status !== "ready"
                ? <ReadStatus state={notes} noun="memories" compact />
                : active.length
                ? (
                  <ul className="grid max-h-80 gap-1.5 overflow-y-auto">
                    {active.map((note) => (
                      <li
                        key={note.id}
                        className="bg-muted/40 rounded-lg border px-3 py-2 text-sm"
                      >
                        <p className="leading-relaxed">
                          {String(note.text ?? "")}
                        </p>
                        {ctx.actions.personal_memory && (
                          <ForgetMemory ctx={ctx} id={note.id} />
                        )}
                        {typeof note.createdAt === "string" && (
                          <p className="text-muted-foreground mt-1 text-xs">
                            {formatRelative(note.createdAt)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )
                : (
                  <p className="text-muted-foreground py-3 text-sm">
                    Nothing remembered yet.
                  </p>
                )}
            </section>
          )}
        </div>
      );
    },
  });

export default view;

function MemoryImport(
  { ctx, participantId }: { ctx: BrowserViewContext; participantId?: string },
) {
  const [error, setError] = React.useState<string>();
  const action = ctx.actions.personal_memory;
  React.useEffect(() => {
    if (!participantId || !action) return;
    let active = true;
    action({ operation: "import" }).result().catch(() => {
      if (active) {
        setError(
          "Could not load older memories. Reopen your profile to retry.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [participantId, action]);
  return error ? <p role="alert">{error}</p> : null;
}

function ForgetMemory({ ctx, id }: { ctx: BrowserViewContext; id: string }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  return (
    <>
      <button
        type="button"
        disabled={busy}
        className="text-muted-foreground mt-1 text-xs underline"
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await ctx.actions.personal_memory({ operation: "retire", id })
              .result();
          } catch {
            setError("Could not forget this memory. Try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Forgetting…" : "Forget"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
