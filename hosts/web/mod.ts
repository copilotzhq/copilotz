/**
 * The web host, for the browser: `web()` runs the app there, as the signed-in
 * person, in the app's theme. What features' web front ends use, as they'd
 * use React: `Part`, `LazyView` (a View shown only while a component is),
 * `go` (moving on without reloading), `signOut`, the command palette's
 * items and steps (`openPalette`, at a step, from anywhere), and the toolkit
 * (`toolkit/`), whose pieces take their look from the theme's variables
 * (`theme/`): a front end composes them, and its own CSS is only its layout,
 * on those variables. The server half is `server.ts` (with
 * `tickets.ts`), for the process that serves the page.
 */
export { go, signOut, web, type WebOptions, type Where } from "./host.tsx";
export { message, node, Part } from "./part.tsx";
export { LazyView } from "./lazy.tsx";
// The command palette: the page's (the shell shows it), and opening it at a step from anywhere.
export { Palette } from "./palette/palette.tsx";
export {
  closePalette,
  openPalette,
  type PaletteControl,
  type PaletteDialog,
  type PaletteGroup,
  type PaletteItem,
  type PaletteStep,
} from "./palette/state.ts";
export { DEFAULT_THEME, type Theme } from "./theme/default.ts";
export type { Drawing, Picture } from "./theme/picture.ts";

// The toolkit: actions and fields.
export { Button, type ButtonProps } from "./toolkit/button.tsx";
export { IconButton, type IconButtonProps } from "./toolkit/icon-button.tsx";
export { CopyButton } from "./toolkit/copy-button.tsx";
export { Input } from "./toolkit/input.tsx";
export { InlineEdit } from "./toolkit/inline-edit.tsx";
export { Textarea } from "./toolkit/textarea.tsx";
export { type Control, Field } from "./toolkit/field.tsx";
export { Select } from "./toolkit/select.tsx";
export { Checkbox } from "./toolkit/checkbox.tsx";
export { Autocomplete, type AutocompleteOption, optionId } from "./toolkit/autocomplete.tsx";
// Surfaces and labels.
export { Card } from "./toolkit/card.tsx";
export { Badge, type Tone } from "./toolkit/badge.tsx";
export { Chip } from "./toolkit/chip.tsx";
export { Avatar } from "./toolkit/avatar.tsx";
export { Icon, type IconName, ICONS } from "./toolkit/icon.tsx";
export { Logo } from "./toolkit/logo.tsx";
// Overlays and navigation.
export { Menu, type MenuItem } from "./toolkit/menu.tsx";
export { Dialog } from "./toolkit/dialog.tsx";
export { Drawer } from "./toolkit/drawer.tsx";
export { type Tab, Tabs } from "./toolkit/tabs.tsx";
export { NavItem } from "./toolkit/nav-item.tsx";
export { ResizeHandle } from "./toolkit/resize-handle.tsx";
export { Tooltip } from "./toolkit/tooltip.tsx";
// Pages and details.
export { Page } from "./toolkit/page.tsx";
export { type Detail, DetailList } from "./toolkit/detail-list.tsx";
export { DetailValue } from "./toolkit/detail-value.tsx";
export { humanize } from "./toolkit/humanize.ts";
// Status and text.
export { Spinner } from "./toolkit/spinner.tsx";
export { Skeleton } from "./toolkit/skeleton.tsx";
export { EmptyState } from "./toolkit/empty-state.tsx";
export { Notice } from "./toolkit/notice.tsx";
export { Kbd } from "./toolkit/kbd.tsx";
export { ago } from "./toolkit/ago.ts";
export { keep, kept } from "./toolkit/kept.ts";
export { Time } from "./toolkit/time.tsx";
export { LongText } from "./toolkit/long-text.tsx";
export { CodeBlock, type CodePart, type CodeTone } from "./toolkit/code-block.tsx";
export { bytes } from "./toolkit/bytes.ts";
export { Markdown } from "./toolkit/markdown/markdown.tsx";
export { safeHref } from "./toolkit/markdown/spans.ts";
export { Title } from "./toolkit/title.tsx";
// A terminal, for a shell that runs a line at a time.
export { Terminal, type TerminalOutput, type TerminalSession } from "./toolkit/terminal.tsx";
// Sound.
export { AudioPlayer } from "./toolkit/audio-player.tsx";
export { Waveform } from "./toolkit/waveform.tsx";
export { resample } from "./toolkit/resample.ts";
export { clock } from "./toolkit/clock.ts";
export type { Client } from "../../runtime/client.ts";
