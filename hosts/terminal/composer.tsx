/**
 * Where you type: the prompt, and a line that autocompletes commands. Enter
 * runs it (the host's `submit`); while it runs, the line waits. A command's
 * key (Esc) runs it at any time.
 */
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from "react";

export type Typing = {
  /** Runs a line: a command, or text for the `"*"` command. */
  submit(line: string): Promise<void>;
  /** Whether a line is running now, and word when that changes. */
  busy: { get(): boolean; subscribe(listener: () => void): () => void };
  /** Command names, to complete what's typed. */
  suggestions: string[];
  /** What commands' keys run. */
  keys: { escape?(): void };
  /** False when lines come from a script: nothing to type into. */
  interactive: boolean;
};

export const TypingContext = createContext<Typing | undefined>(undefined);

export function Composer({ prompt }: { prompt: unknown }): ReactNode {
  const typing = useContext(TypingContext);
  const busy = useSyncExternalStore(
    typing?.busy.subscribe ?? (() => () => {}),
    typing?.busy.get ?? (() => false),
  );
  // A new input each line: it starts empty.
  const [line, setLine] = useState(0);
  useInput((_, key) => void (key.escape && typing?.keys.escape?.()), {
    isActive: Boolean(typing?.interactive && typing.keys.escape),
  });
  if (!typing?.interactive) return null;
  return (
    <Box>
      <Text>{prompt as ReactNode}</Text>
      <TextInput
        key={line}
        isDisabled={busy}
        suggestions={typing.suggestions}
        onSubmit={(text) => {
          setLine(line + 1);
          void typing.submit(text);
        }}
      />
    </Box>
  );
}
