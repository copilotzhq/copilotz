/**
 * The date-time picker as the page draws it: the field shows the value in the app's format (a
 * pattern, a function, or the page language's), names itself with it, sends it with a form as
 * written, and its panel has the month, the time's two spin fields named in the page's language,
 * and Cancel and Apply.
 */
import { assert, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { DateTimePicker, formatDayTime } from "../toolkit/date-time-picker.tsx";

const markup = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

test("a day-time in the app's format: a pattern, a function, or the page language's", () => {
  const at = "2026-11-16 09:05";
  assertStringIncludes(formatDayTime(at, "dd/MM/yyyy HH:mm"), "16/11/2026 09:05");
  assertStringIncludes(formatDayTime(at, "d MMM yyyy, h:mm a"), "16 Nov 2026, 9:05 AM");
  assertStringIncludes(formatDayTime(at, (v) => `[${v}]`), "[2026-11-16 09:05]");
  const plain = formatDayTime(at);
  assert(plain.includes("9:05") || plain.includes("09:05"), plain);
  assertStringIncludes(plain, "16");
});

test("the field: the value, named with it; a hidden field sends it as written", () => {
  const html = markup(
    <DateTimePicker
      id="opened"
      name="open_date"
      label="Opened"
      value="2026-11-16 22:38"
      onChange={() => {}}
      format="dd/MM/yyyy HH:mm"
      today="2026-11-16"
    />,
  );
  assertStringIncludes(html, '<input type="hidden" name="open_date" value="2026-11-16 22:38"/>');
  assertStringIncludes(html, 'id="opened"');
  assertStringIncludes(html, 'aria-label="Opened: 16/11/2026 22:38"');
  assertStringIncludes(html, ">16/11/2026 22:38</span>");
});

test("the panel: the month, the time's hours and minutes as spin fields, Cancel and Apply", () => {
  const html = markup(
    <DateTimePicker label="Opened" value="2026-11-16 22:38" onChange={() => {}} minuteStep={5} />,
  );
  assertStringIncludes(html, 'role="grid"');
  assertStringIncludes(html, 'aria-selected="true"');
  assertStringIncludes(html, ">Time of day</span>");
  assertStringIncludes(
    html,
    'role="spinbutton" aria-label="hour" aria-valuemin="0" aria-valuemax="23" aria-valuenow="22"',
  );
  assertStringIncludes(
    html,
    'aria-label="minute" aria-valuemin="0" aria-valuemax="59" aria-valuenow="38"',
  );
  assertStringIncludes(html, 'value="38"');
  assertStringIncludes(html, ">Cancel</button>");
  assertStringIncludes(html, ">Apply</button>");
});

test("with no value: the placeholder, named by the label alone", () => {
  const html = markup(
    <DateTimePicker label="Opened" placeholder="When?" onChange={() => {}} today="2026-11-16" />,
  );
  assertStringIncludes(html, 'aria-label="Opened"');
  assertStringIncludes(html, 'copilotz-date-time-placeholder">When?</span>');
  assert(!html.includes('type="hidden"'));
});

test("a value with seconds shows them in the field and keeps them in the form", () => {
  const html = markup(
    <DateTimePicker
      name="opened"
      value="2026-11-16 22:38:42"
      onChange={() => {}}
      format="dd/MM/yyyy HH:mm:ss"
      today="2026-11-16"
    />,
  );
  assertStringIncludes(html, 'value="2026-11-16 22:38:42"');
  assertStringIncludes(html, ">16/11/2026 22:38:42</span>");
  // Without `seconds` the panel stays hours and minutes.
  assert(!html.includes('aria-label="second"'));
});

test("seconds: a third field, and the value always has them", () => {
  const html = markup(
    <DateTimePicker seconds value="2026-11-16 22:38" onChange={() => {}} format="HH:mm:ss" />,
  );
  assertStringIncludes(
    html,
    'aria-label="second" aria-valuemin="0" aria-valuemax="59" aria-valuenow="0"',
  );
  assertStringIncludes(html, ">22:38:00</span>");
});
