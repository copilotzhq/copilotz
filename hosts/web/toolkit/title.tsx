/** The page's title while something shows: `text · app`, or the app's name alone. */
import { useEffect } from "react";

/** The app's name: the title the page came with. */
const app = globalThis.document?.title ?? "";

export function Title({ text }: { text?: string }): null {
  useEffect(() => {
    document.title = text ? `${text} · ${app}` : app;
  }, [text]);
  return null;
}
