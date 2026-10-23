/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Kit extension: Radix dropdown menu in the shared shadcn style. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { CheckIcon, ChevronRightIcon, DotIcon } from "lucide-react";
import { cn } from "../utils.ts";

export const DropdownMenu: typeof Menu.Root = Menu.Root;
export const DropdownMenuTrigger: typeof Menu.Trigger = Menu.Trigger;
export const DropdownMenuGroup: typeof Menu.Group = Menu.Group;
export const DropdownMenuSub: typeof Menu.Sub = Menu.Sub;
export const DropdownMenuRadioGroup: typeof Menu.RadioGroup = Menu.RadioGroup;

const surface =
  "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[11rem] overflow-x-hidden overflow-y-auto rounded-lg border p-1 shadow-float";
const item =
  "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground";

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
          surface,
          "max-h-(--radix-dropdown-menu-content-available-height) origin-(--radix-dropdown-menu-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem(
  { className, destructive, inset, ...props }:
    & React.ComponentProps<typeof Menu.Item>
    & { destructive?: boolean; inset?: boolean },
): React.ReactElement {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      data-variant={destructive ? "destructive" : undefined}
      className={cn(
        item,
        inset && "pl-8",
        destructive &&
          "text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg:not([class*='text-'])]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem(
  { className, children, checked, ...props }: React.ComponentProps<
    typeof Menu.CheckboxItem
  >,
): React.ReactElement {
  return (
    <Menu.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      checked={checked}
      className={cn(item, "pr-8", className)}
      {...props}
    >
      {children}
      <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
        <Menu.ItemIndicator>
          <CheckIcon className="size-4 text-foreground" />
        </Menu.ItemIndicator>
      </span>
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem(
  { className, children, ...props }: React.ComponentProps<
    typeof Menu.RadioItem
  >,
): React.ReactElement {
  return (
    <Menu.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(item, "pr-8", className)}
      {...props}
    >
      {children}
      <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
        <Menu.ItemIndicator>
          <DotIcon className="size-6 text-foreground" />
        </Menu.ItemIndicator>
      </span>
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel(
  { className, ...props }: React.ComponentProps<typeof Menu.Label>,
): React.ReactElement {
  return (
    <Menu.Label
      data-slot="dropdown-menu-label"
      className={cn(
        "text-muted-foreground px-2 py-1.5 text-xs font-medium",
        className,
      )}
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

export function DropdownMenuShortcut(
  { className, ...props }: React.ComponentProps<"span">,
): React.ReactElement {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger(
  { className, children, ...props }: React.ComponentProps<
    typeof Menu.SubTrigger
  >,
): React.ReactElement {
  return (
    <Menu.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(item, "data-[state=open]:bg-accent", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </Menu.SubTrigger>
  );
}

export function DropdownMenuSubContent(
  { className, ...props }: React.ComponentProps<typeof Menu.SubContent>,
): React.ReactElement {
  return (
    <Menu.Portal>
      <Menu.SubContent
        data-slot="dropdown-menu-sub-content"
        className={cn(
          surface,
          "origin-(--radix-dropdown-menu-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}
