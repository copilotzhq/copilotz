/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** ⌘K: jump to any conversation or Space, or run a shell action. @module */
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import {
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  dom,
  Kbd,
} from "@copilotz/copilotz/web/kit";

export type Command = Readonly<{
  id: string;
  label: string;
  group: string;
  hint?: string;
  icon?: React.ReactNode;
  keywords?: string;
  run(): void;
}>;

export function CommandPalette(
  { open, onOpenChange, commands }: {
    open: boolean;
    onOpenChange(open: boolean): void;
    commands: readonly Command[];
  },
): React.ReactElement {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? commands.filter((command) =>
        `${command.label} ${command.keywords ?? ""} ${command.group}`
          .toLowerCase().includes(needle)
      ).slice(0, 50)
      : commands.slice(0, 50);
  }, [commands, query]);
  useEffect(() => {
    if (!list.current) return;
    dom(list.current).querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [index]);
  const run = (command: Command | undefined) => {
    if (!command) return;
    onOpenChange(false);
    command.run();
  };
  let group = "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search
            aria-hidden="true"
            className="text-muted-foreground size-4 shrink-0"
          />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
            aria-activedescendant={matches[index]
              ? `command-${matches[index].id}`
              : undefined}
            aria-label="Search conversations, Spaces and commands"
            placeholder="Search conversations, Spaces and commands…"
            value={query}
            onChange={(event) => {
              setQuery((event.target as unknown as { value: string }).value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((value) => Math.min(value + 1, matches.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(matches[index]);
              }
            }}
            className="placeholder:text-muted-foreground h-12 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul
          ref={list}
          id="command-list"
          role="listbox"
          className="max-h-[min(24rem,60dvh)] overflow-y-auto p-1.5"
        >
          {matches.map((command, position) => {
            const heading = command.group !== group;
            group = command.group;
            return (
              <React.Fragment key={command.id}>
                {heading && (
                  <li
                    role="presentation"
                    className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium"
                  >
                    {command.group}
                  </li>
                )}
                <li
                  id={`command-${command.id}`}
                  role="option"
                  data-index={position}
                  aria-selected={position === index}
                  onMouseMove={() => setIndex(position)}
                  onClick={() => run(command)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm",
                    position === index && "bg-accent",
                  )}
                >
                  <span className="text-muted-foreground flex size-5 shrink-0 items-center justify-center [&_svg]:size-4">
                    {command.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {command.label}
                  </span>
                  {command.hint && (
                    <span className="text-muted-foreground truncate text-xs">
                      {command.hint}
                    </span>
                  )}
                  {position === index && (
                    <CornerDownLeft
                      aria-hidden="true"
                      className="text-muted-foreground size-3.5"
                    />
                  )}
                </li>
              </React.Fragment>
            );
          })}
          {!matches.length && (
            <li className="text-muted-foreground px-3 py-8 text-center text-sm">
              Nothing matches “{query.trim()}”.
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
