/**
 * The person's menu, at the foot of the sidebar: always a menu, opening with their name (to
 * change, in a dialog that starts with it), then what front ends put there, then signing out.
 * They show by their name; with none, by their email; never by their id. And the frame passes
 * the viewer it's given (the host keeps it as their record says), so a new name shows there.
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../../testing/mod.ts";
import { Frame } from "../views/frame.tsx";
import { Me } from "../views/me.tsx";

const noCall = () => Promise.resolve({} as never);

/** A person's id as an app may make them: it says nothing, and never shows. */
const ID = "01JD3XQ7Z8K2M4N6P8R0S2T4V6";

const plain = (markup: string) => markup.replace(/<style[\s\S]*?<\/style>/g, "");

/** What the button under the sidebar says: the main line, and the note under it. */
const button = (markup: string) => {
  const [, inside = ""] =
    markup.match(/<button[^>]*copilotz-me-button[^>]*>([\s\S]*?)<\/button>/) ??
      [];
  const text = (name: string) => inside.match(new RegExp(`class="${name}">([^<]*)<`))?.[1];
  return { name: text("copilotz-me-name"), note: text("copilotz-me-note") };
};

/** The menu's items, in order (a separator as `—`). */
const items = (markup: string) =>
  [...markup.matchAll(/role="separator"|copilotz-menu-label">([^<]*)</g)]
    .map(([, label]) => label ?? "—");

/** The name field in the dialog: its value and length, and the dialog's title. */
const dialog = (markup: string) => ({
  title: markup.match(/class="copilotz-dialog-title">([^<]*)</)?.[1],
  field: markup.match(/<input[^>]*autoComplete="name"[^>]*>|<input[^>]*autocomplete="name"[^>]*>/)
    ?.[0] ?? "",
});

test("a person with a name: it, their email under it; the menu opens with their name to change", () => {
  const markup = plain(renderToStaticMarkup(
    <Me
      name="Ana Lima"
      email="ana@example.com"
      menu={[{ label: "Connected accounts", href: "/accounts" }]}
      call={noCall}
    />,
  ));
  assertEquals(button(markup), { name: "Ana Lima", note: "ana@example.com" });
  assertEquals(items(markup), ["Your name", "Connected accounts", "—", "Sign out"]);
  const { title, field } = dialog(markup);
  assertEquals(title, "Your name");
  assertStringIncludes(field, 'value="Ana Lima"');
  assertStringIncludes(field, 'maxLength="80"');
  assertStringIncludes(markup, "How people and agents here see you.");
  assertStringIncludes(markup, "Leave it empty to go by your email.");
  for (const word of ["Cancel", "Save"]) assertStringIncludes(markup, `>${word}</button>`);
});

test("a person with no name shows by their email, and is asked for one; nothing else needs a front end", () => {
  const markup = plain(renderToStaticMarkup(<Me email="ana@example.com" call={noCall} />));
  assertEquals(button(markup), { name: "ana@example.com", note: "Signed in" });
  // Always a menu, though no front end put anything in it.
  assertEquals(items(markup), ["Add your name", "—", "Sign out"]);
  const { title, field } = dialog(markup);
  assertEquals(title, "Add your name");
  assertStringIncludes(field, 'value=""');
});

test("with neither a name nor an email: their account, never their id", () => {
  const markup = plain(renderToStaticMarkup(
    <Frame
      path="/"
      brand="Harbor"
      viewer={ID}
      sidebar={null}
      menu={[]}
      call={noCall}
      palette={{ sources: [], hints: {} }}
    >
      {null}
    </Frame>,
  ));
  assertEquals(button(markup), { name: "Your account", note: "Signed in" });
  assertFalse(markup.includes(ID));
});

test("the frame shows the viewer it's given: a new name at once, and with none, their email", () => {
  const draw = (label?: string) =>
    plain(renderToStaticMarkup(
      <Frame
        path="/"
        brand="Harbor"
        viewer={ID}
        {...(label ? { label } : {})}
        email="ana@example.com"
        sidebar={null}
        menu={[]}
        call={noCall}
        palette={{ sources: [], hints: {} }}
      >
        {null}
      </Frame>,
    ));
  const named = draw("Ana Lima");
  assertEquals(button(named), { name: "Ana Lima", note: "ana@example.com" });
  assert(items(named).includes("Your name"));
  const unnamed = draw();
  assertEquals(button(unnamed), { name: "ana@example.com", note: "Signed in" });
  assert(items(unnamed).includes("Add your name"));
  assertFalse(unnamed.includes(ID));
});
