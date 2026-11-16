/**
 * The live waveform, as a recording draws it: each bar scaled to its level, never animated. Its
 * bars change many times a second, and Safari on iOS keeps memory for every CSS transition started
 * that often: recording for half a minute, a page grew past what iOS allows, and was closed.
 */
import { assertMatch, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { Waveform } from "../toolkit/waveform.tsx";
import { test } from "../../../testing/mod.ts";

test("a live waveform's bars are scaled to their level, with no transition", () => {
  const html = renderToStaticMarkup(<Waveform live peaks={[0.5, 1]} bars={4} />);
  const live = html.slice(html.indexOf(".copilotz-waveform-live i {"));
  const rule = live.slice(0, live.indexOf("}"));
  assertStringIncludes(rule, "transform: scaleY(var(--level))");
  assertStringIncludes(rule, "transition: none");
  assertMatch(html, /<i style="--level:0.500"><\/i><i style="--level:1.000"><\/i><\/div>$/);
});
