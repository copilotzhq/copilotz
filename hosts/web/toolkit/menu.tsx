/// <reference lib="dom" />
/**
 * A menu of actions behind a button: an icon button (`icon`, "more" by
 * default) named by `label`, or a button that says `text`. Items are data:
 * a `label`, an `icon`, what selecting it does (`onSelect`) or where it goes
 * (`href`), `tone: "destructive"`, `disabled`, a `shortcut` to show; and
 * `"separator"` between groups.
 *
 * It's an auto popover (the top layer; a click outside or Escape closes it)
 * placed under its button (`anchor`). Opening it, or ArrowDown on the
 * button, focuses the first item; arrows, Home, End and a letter move
 * between them; choosing one, Escape or Tab closes it, and focus returns to
 * the button.
 *
 * ```tsx
 * <Menu label="Conversation" items={[
 *   { label: "Share", icon: "share", onSelect: share },
 *   "separator",
 *   { label: "Delete", icon: "trash", tone: "destructive", onSelect: remove },
 * ]} />
 * ```
 */
import {
  type KeyboardEvent,
  type ReactNode,
  type ToggleEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { anchor, ANCHORED } from "./anchor.tsx";
import { Button } from "./button.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { IconButton } from "./icon-button.tsx";
import { Kbd } from "./kbd.tsx";
import { sheet } from "./sheet.tsx";

export type MenuItem = {
  label: string;
  icon?: IconName;
  onSelect?(): void;
  href?: string;
  tone?: "destructive";
  disabled?: boolean;
  shortcut?: string;
};

const SHEET = sheet(
  "menu",
  `
.copilotz-menu { min-width: 200px; max-width: min(320px, calc(100vw - 16px)); padding: 5px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-md); overflow: auto;
  max-height: min(420px, calc(100vh - 32px)); }
.copilotz-menu:popover-open { animation: copilotz-menu .14s ease-out; }
@keyframes copilotz-menu { from { opacity: 0; transform: translateY(-3px) scale(.98); } }
.copilotz-menu-item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px;
  padding: 6px 10px; border: 0; border-radius: var(--radius-sm); background: transparent; color: inherit;
  font-size: 14px; text-align: left; text-decoration: none; cursor: pointer; outline: none; }
.copilotz-menu-item > .copilotz-icon { color: var(--muted-foreground); }
.copilotz-menu-item:hover, .copilotz-menu-item:focus-visible, .copilotz-menu-item:focus {
  background: var(--accent); color: var(--accent-foreground); }
.copilotz-menu-item:disabled { opacity: .5; cursor: default; background: transparent; }
.copilotz-menu-item[data-tone=destructive], .copilotz-menu-item[data-tone=destructive] > .copilotz-icon {
  color: var(--destructive-text); }
.copilotz-menu-item[data-tone=destructive]:focus, .copilotz-menu-item[data-tone=destructive]:hover {
  background: var(--destructive-soft); }
.copilotz-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-menu-separator { height: 1px; margin: 5px -5px; background: var(--border); }
`,
);

/** The enabled items in a menu, in order. */
const itemsOf = (
  menu: HTMLElement | null,
) => [...menu?.querySelectorAll<HTMLElement>(".copilotz-menu-item:not(:disabled)") ?? []];

export function Menu(
  { label, icon = "more", text, items, align = "start", variant, size }: {
    /** What the menu is, said to screen readers (and the icon button's tooltip). */
    label: string;
    icon?: IconName;
    /** A button with words instead of an icon. */
    text?: string;
    items: (MenuItem | "separator")[];
    align?: "start" | "end";
    variant?: "ghost" | "outline" | "secondary";
    size?: "sm" | "md" | "lg";
  },
): ReactNode {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const typed = useRef({ text: "", at: 0 });

  useEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    return anchor(menu.current, trigger.current, { side: "bottom", align });
  }, [open]);

  const focus = (which: "first" | "last" | number) => {
    const all = itemsOf(menu.current);
    const at = which === "first" ? 0 : which === "last" ? all.length - 1 : which;
    all[(at + all.length) % all.length]?.focus();
  };
  const close = () => menu.current?.hidePopover();

  const toggled = (event: ToggleEvent<HTMLDivElement>) => {
    const opened = event.newState === "open";
    setOpen(opened);
    if (opened) requestAnimationFrame(() => focus("first"));
    else if (
      !document.activeElement || document.activeElement === document.body ||
      menu.current?.contains(document.activeElement)
    ) trigger.current?.focus();
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = itemsOf(menu.current);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move: Record<string, () => void> = {
      ArrowDown: () => focus(at + 1),
      ArrowUp: () => focus(at - 1),
      Home: () => focus("first"),
      End: () => focus("last"),
      Tab: close,
    };
    if (move[event.key]) {
      if (event.key !== "Tab") event.preventDefault();
      return move[event.key]();
    }
    // A letter goes to the next item starting with what's been typed.
    if (event.key.length === 1 && /\S/.test(event.key)) {
      const now = Date.now();
      typed.current = {
        text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(),
        at: now,
      };
      const next = [...all.slice(at + 1), ...all.slice(0, at + 1)]
        .find((item) => item.textContent?.trim().toLowerCase().startsWith(typed.current.text));
      next?.focus();
    }
  };

  const opener = {
    ref: trigger,
    popoverTarget: `${id}-menu`,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": `${id}-menu`,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      menu.current?.showPopover();
      requestAnimationFrame(() => focus(event.key === "ArrowUp" ? "last" : "first"));
    },
  };

  return (
    <>
      {SHEET}
      {ANCHORED}
      {text
        ? (
          <Button {...opener} variant={variant ?? "outline"} size={size} iconEnd="chevron-down">
            {text}
          </Button>
        )
        : (
          <IconButton
            {...opener}
            icon={icon}
            label={label}
            variant={variant ?? "ghost"}
            size={size}
            tooltip={!open}
          />
        )}
      <div
        ref={menu}
        id={`${id}-menu`}
        popover="auto"
        role="menu"
        aria-label={label}
        className="copilotz-menu copilotz-anchored"
        onToggle={toggled}
        onKeyDown={keys}
      >
        {items.map((item, i) =>
          item === "separator"
            ? <div key={i} role="separator" className="copilotz-menu-separator" />
            : <Item key={i} item={item} done={close} />
        )}
      </div>
    </>
  );
}

function Item({ item, done }: { item: MenuItem; done(): void }): ReactNode {
  const inside = (
    <>
      {item.icon ? <Icon name={item.icon} size={16} /> : null}
      <span className="copilotz-menu-label">{item.label}</span>
      {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
    </>
  );
  const common = {
    role: "menuitem",
    tabIndex: -1,
    className: "copilotz-menu-item",
    "data-tone": item.tone,
  };
  if (item.href && !item.disabled) {
    return (
      <a
        {...common}
        href={item.href}
        onClick={() => {
          done();
          item.onSelect?.();
        }}
      >
        {inside}
      </a>
    );
  }
  return (
    <button
      type="button"
      {...common}
      disabled={item.disabled}
      onClick={() => {
        done();
        item.onSelect?.();
      }}
    >
      {inside}
    </button>
  );
}
