# Shared UI kit

One design system for every Copilotz browser plugin and the apps built on them.
Apps import `@copilotz/copilotz/web/kit`; core entry points import none of it.

`styles.css` defines the tokens for light and `.dark`: white and slate,
`--radius: 0.5rem`, the system font, plus the message bubble, sidebar and code
tokens. Prose and highlighted code are themed through the same tokens. Brand an
app by overriding `--primary` and `--primary-foreground` (and `--bubble` for the
reader's messages).

`components/` holds the shadcn-style primitives with Radix behavior and
Tailwind/CVA variants: Button, Badge, Card, Input, Textarea, Dialog,
DropdownMenu, Tabs, TabBar, Tooltip, Avatar, ScrollArea, Separator, Kbd,
Spinner, Field, NativeSelect, Checkbox, Notice, EmptyState, CopyField and the
dialog patterns (ConfirmDialog, ConfirmAction, FormDialog,
NameDescriptionDialog). `patterns.tsx` adds Screen, ReadStatus (one vocabulary
for every read state, including the live read limits), Metric, DetailList and
the resource list and table patterns. `Icon` names a curated lucide set, so apps
can name icons in resources.

`Markdown` renders GitHub-flavored Markdown, math with KaTeX and highlighted
code, and applies `markdownUrlPolicy` from `@copilotz/copilotz/web`: it discards
raw HTML, drops unsafe links, opens links in a new tab without a referrer, and
loads only relative, same-origin or `imageOrigins` images. Any other image
renders as its alt text and is never fetched. Math and highlighting load on
first use (`preloadMarkdown()` loads them at once).

Process `styles.css` with Tailwind CSS 4, `@tailwindcss/typography` and
`tw-animate-css`. It imports KaTeX's stylesheet; serve `katex/dist/fonts` at
`fonts/` next to the compiled CSS unless the pipeline rebases `url()`. Add the
app's own source path to Tailwind scanning. React and React DOM must resolve to
one copy in the host bundle (19.1.1 in this repository).

TSX sources carry explicit React runtime imports and JSX pragmas, so hosts need
no JSX compiler override. The npm source package exports
`@copilotz/copilotz/web/kit/styles.css`. JSR includes the CSS asset in its
archive but its publisher cannot export CSS modules. See
`docs/web-runtime-and-views.md` for the components' contracts and the npm/JSR
packaging distinction.
