/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** The account menu at the foot of the sidebar. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { ChevronsUpDown, Monitor, Moon, Sun, User } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  initials,
} from "@copilotz/copilotz/web/kit";
import type { MenuItem } from "../model.ts";

export function UserMenu(
  { user, theme, onTheme, onProfile, items, onItem }: {
    user?: Readonly<{ name?: string; email?: string }>;
    theme: "light" | "dark" | "system";
    onTheme(theme: "light" | "dark" | "system"): void;
    onProfile?(): void;
    items: readonly MenuItem[];
    onItem(item: MenuItem): void;
  },
): React.ReactElement {
  const name = user?.name || user?.email?.split("@")[0] || "Guest";
  const mark = (
    <Avatar className="size-8 rounded-lg">
      <AvatarFallback className="bg-primary/10 text-foreground rounded-lg text-xs font-semibold">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account: ${name}`}
          className="hover:bg-sidebar-accent focus-visible:ring-sidebar-ring/50 data-[state=open]:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left outline-none focus-visible:ring-2 @max-[12rem]/sidebar:justify-center"
        >
          {mark}
          <span className="grid min-w-0 flex-1 @max-[12rem]/sidebar:hidden">
            <span className="truncate text-sm font-medium">{name}</span>
            {user?.email && (
              <span className="text-muted-foreground truncate text-xs">
                {user.email}
              </span>
            )}
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="text-muted-foreground size-4 @max-[12rem]/sidebar:hidden"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
      >
        <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
          {mark}
          <span className="grid min-w-0">
            <span className="text-foreground truncate text-sm font-medium">
              {name}
            </span>
            {user?.email && <span className="truncate">{user.email}</span>}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {onProfile && (
          <DropdownMenuItem onSelect={onProfile}>
            <User /> Profile and memories
          </DropdownMenuItem>
        )}
        {items.filter((item) => !item.destructive).map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => onItem(item)}
          >
            <Icon name={item.icon} /> {item.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => onTheme(value as typeof theme)}
        >
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {items.some((item) => item.destructive) && (
          <>
            <DropdownMenuSeparator />
            {items.filter((item) => item.destructive).map((item) => (
              <DropdownMenuItem
                key={item.id}
                destructive
                onSelect={() => onItem(item)}
                className={cn()}
              >
                <Icon name={item.icon} /> {item.label}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
