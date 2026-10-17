/** Ordinary plugin source: every primitive is authored through the package root. */
import {
  contribution,
  defineAction,
  defineCollection,
  definePlugin,
  defineProcessor,
  defineView,
  type RuntimeContext,
} from "@copilotz/copilotz";

const action = defineAction({
  id: "artifact.echo",
  execute(
    input: { text: string },
    context: RuntimeContext<
      Record<string, never>,
      { format: { text(text: string): string } }
    >,
  ) {
    return context.adapters.format.text(input.text);
  },
});
const collection = defineCollection({
  name: "artifact_notes",
  schema: { type: "object", properties: { text: { type: "string" } } },
});
const processor = defineProcessor({
  id: "artifact.observe",
  on: [{ eventType: "artifact_notes.created" }],
  handle() {},
});
const view = defineView({
  id: "artifact.note",
  shows: "artifact_notes",
  renderer: "text",
  modes: ["context"],
  render(item: { text: string }) {
    return item.text;
  },
});
export default definePlugin({
  id: "artifact.whole",
  version: "1",
  actions: { echo: action },
  collections: { notes: collection },
  processors: { observe: processor },
  resources: { formats: { default: { prefix: "Note: " } } },
  adapters: { format: { text: (text: string) => `Note: ${text}` } },
  views: { note: view },
});

export const withoutViews = definePlugin({
  id: "artifact.no-views",
  version: "1",
  actions: { echo: action },
});
export const contributed = definePlugin({
  id: "artifact.contributed",
  version: "1",
  resources: {
    presentations: {
      note: {
        [contribution]() {
          return { value: { mode: "context" as const }, views: { note: view } };
        },
      },
    },
  },
});
// Inference must survive the ordinary root surface, including contributions.
type EchoOutput = ReturnType<typeof action.execute>;
const inferredOutput: EchoOutput = "test";
const inferredMode: "context" = contributed.resources.presentations.note.mode;
void inferredOutput;
void inferredMode;
