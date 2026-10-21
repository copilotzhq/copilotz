/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
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
 * plugin's notes (`memoryNote`), read-only and only those the server lets
 * this person read; without that Collection the section is omitted.
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
      const notes = ctx.collections.memoryNote?.list({
        order: { field: "id", direction: "desc" },
        limit: 50,
      });
      const active = notes?.value.filter((note) => !note.retirement) ?? [];
      return (
        <div className="grid gap-5">
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
                Notes agents kept from your conversations. They update as you
                talk.
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
