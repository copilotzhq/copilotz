/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Kit extension: Radix dropdown menu in the shared shadcn style. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { cn } from "../utils.ts";

export const DropdownMenu: typeof Menu.Root = Menu.Root;
export const DropdownMenuTrigger: typeof Menu.Trigger = Menu.Trigger;

export function DropdownMenuContent(
  { className, sideOffset = 4, ...props }: React.ComponentProps<
    typeof Menu.Content
  >,
): React.ReactElement {
  return (
    <Menu.Portal>
      <Menu.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground z-50 min-w-[10rem] overflow-hidden rounded-md border p-1 shadow-md",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem(
  { className, destructive, ...props }:
    & React.ComponentProps<typeof Menu.Item>
    & { destructive?: boolean },
): React.ReactElement {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        destructive && "text-destructive focus:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel(
  { className, ...props }: React.ComponentProps<typeof Menu.Label>,
): React.ReactElement {
  return (
    <Menu.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2 py-1.5 text-sm font-medium", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator(
  { className, ...props }: React.ComponentProps<typeof Menu.Separator>,
): React.ReactElement {
  return (
    <Menu.Separator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}
