# Shared UI kit

The components in `components/` are the existing MIT shadcn-style components
consolidated from the read-only chat UI source. They retain Radix behavior and
Tailwind/CVA variants. `patterns.tsx` extends them for Views; Markdown is
shared. Apps import `@copilotz/copilotz/web/kit` and reuse plugin Views.

`Markdown` applies `markdownUrlPolicy` from `@copilotz/copilotz/web`: it drops
unsafe links, opens links in a new tab without a referrer, and loads only
relative, same-origin or `imageOrigins` images. Any other image renders as its
alt text and is never fetched. `ReadStatus` renders a `held` query read (a View
opened from a URL) with a Load button that starts it.

Process `styles.css` with Tailwind CSS 4 and `@tailwindcss/typography`. Add the
app's own source path to Tailwind scanning. React and React DOM must resolve to
one copy in the host bundle (19.1.1 in this repository). Core entry points
import none of it.

Additional shared components: Tabs and DropdownMenu families, Field,
NativeSelect, Checkbox, Notice, EmptyState, CopyField, ConfirmAction, Frame,
PaneBoundary and showSafely. See `docs/web-runtime-and-views.md` for composition
and callback contracts.

TSX sources carry explicit React runtime imports and JSX pragmas, so hosts need
no JSX compiler override. The npm source package exports
`@copilotz/copilotz/web/kit/styles.css`. JSR includes the CSS asset in its
archive but its publisher cannot export CSS modules; see the web runtime
documentation for asset setup and the npm/JSR packaging distinction.
