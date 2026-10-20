# Shared UI kit

The components in `components/` are the existing MIT shadcn-style components
consolidated from the read-only chat UI source. They retain Radix behavior and
Tailwind/CVA variants. `patterns.tsx` extends them for Views; Markdown is
shared. Apps import `@copilotz/copilotz/web/kit` and reuse plugin Views.

Process `styles.css` with Tailwind CSS 4 and `@tailwindcss/typography`. Add the
app's own source path to Tailwind scanning. React and React DOM must resolve to
one copy in the host bundle (19.1.1 in this repository). Core entry points
import none of it.
