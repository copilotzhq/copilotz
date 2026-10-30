/**
 * Agents' steps in the command palette: picking one of the spaces the
 * person manages (to add an agent there, or make one there), and deleting
 * an agent, a question that says what it means before it's done.
 */
import { Avatar, type PaletteControl, type PaletteStep } from "../../../../../hosts/web/mod.ts";
import { type Place, placeName } from "./places.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A space they manage, picked: what happens there is `pick`'s. */
export function spaceStep(
  { title, note, places, pick }: {
    title: string;
    note?: string;
    places: Place[];
    pick(place: Place, palette: PaletteControl): unknown;
  },
): PaletteStep {
  return {
    title,
    placeholder: "Find a space",
    ...(note ? { note } : {}),
    items: () => [{
      title: "Spaces you manage",
      items: places.map((place) => ({
        key: `agent-space:${place._id}`,
        label: placeName(place),
        ...(place.kind === "personal"
          ? { icon: "person" as const, description: "Just you", keywords: ["personal"] }
          : { leading: <Avatar name={place.name} kind="space" size={26} /> }),
        run: (palette: PaletteControl) => pick(place, palette),
      })),
    }],
  };
}

/** Deleting an agent, once they've read what it means; then `after`. */
export function deleteStep(
  { agent, name, call, after }: { agent: string; name: string; call: Call; after(): void },
): PaletteStep {
  return {
    title: `Delete ${name}?`,
    confirm: true,
    note: "It leaves every space it works in, and nobody can ask it anything again. " +
      "Chats it was in stay as they are.",
    items: () => [{
      title: "",
      items: [
        {
          key: "agent:delete",
          label: `Delete ${name}`,
          icon: "trash",
          tone: "destructive",
          run: async () => {
            await call("agent.delete", { agent });
            after();
          },
        },
        { key: "agent:keep", label: "Keep it", icon: "close", run: (p) => p.back() },
      ],
    }],
  };
}
