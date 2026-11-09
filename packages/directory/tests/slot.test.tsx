/**
 * The directory fills the web shell's `orgs` slot: `directoryWeb` names its switcher, its overlay
 * and its hook; once the browser's orgs are known, the hook gives the person's email, the org's
 * page and (for staff) every org in their menu, and orgs in the palette; the switcher shows the
 * org they're in, and the overlay the line along the top while in it as staff.
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "copilotz";
import type { OrgsSlot } from "copilotz/plugins/interfaces/contract";
import { test } from "copilotz/testing";
import { directoryWeb, type Orgs, refreshOrgs } from "../web.tsx";
import { overlayView, switcherView, useShellOrgs } from "../views/web/switcher.tsx";

const noCall = () => Promise.reject(new Error("no call"));
const ctx = { call: noCall, hints: {}, resources: {} } as unknown as ViewContext<ReactNode>;

const orgs = (more: Partial<Orgs> = {}): Orgs => ({
  person: "ana",
  email: "ana@example.com",
  current: "o-1",
  orgs: [{ id: "p-1", name: "ana", kind: "personal" }, { id: "o-1", name: "Acme", kind: "team" }],
  invites: [],
  staff: true,
  asStaff: false,
  ...more,
});

/** The browser's orgs, as a server with many answers them. */
async function known(value: Orgs) {
  const fetched = globalThis.fetch;
  try {
    globalThis.fetch = (() => Promise.resolve(Response.json(value))) as typeof fetch;
    await refreshOrgs();
  } finally {
    globalThis.fetch = fetched;
  }
}

function Shown(): ReactNode {
  const shown = useShellOrgs(noCall);
  return (
    <pre>
      {JSON.stringify({
        email: shown?.email,
        menu: shown?.menu?.map((m) => m.href),
        palette: shown?.palette?.map((g) => g.title),
      })}
    </pre>
  );
}

test("directoryWeb fills the orgs slot: its switcher, its overlay, its hook", () => {
  const slot = directoryWeb.resources?.orgs as OrgsSlot;
  assertEquals([slot.switcher, slot.overlay, slot.use], [
    "orgs.switcher",
    "orgs.overlay",
    useShellOrgs,
  ]);
  assert(directoryWeb.views?.[slot.switcher] && directoryWeb.views?.[slot.overlay!]);
  assert(directoryWeb.views?.org && directoryWeb.views?.console);
});

test("the orgs known: the hook lists them, the switcher shows where you are", async () => {
  await known(orgs());
  const said = JSON.parse(
    renderToStaticMarkup(<Shown />).replace(/^<pre>|<\/pre>$/g, "").replace(/&quot;/g, '"'),
  );
  assertEquals(said.email, "ana@example.com");
  assertEquals(said.menu, ["/org", "/console"]);
  assert(said.palette.length > 0);
  const switcher = renderToStaticMarkup(<>{switcherView(null, ctx)}</>);
  assertStringIncludes(switcher, "Acme");
  assertFalse(renderToStaticMarkup(<>{overlayView()}</>).includes(`class="copilotz-staff-line"`));
});

test("in an org as staff: the overlay's line along the top", async () => {
  await known(orgs({ asStaff: true }));
  assertStringIncludes(renderToStaticMarkup(<>{overlayView()}</>), `class="copilotz-staff-line"`);
});
