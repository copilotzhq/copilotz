import type { CopilotzEvent } from "../events/types.ts";
import { matchProcessor } from "./match.ts";
import type { Processor } from "./processor.ts";

export type TransientProcessorSet = Readonly<{
  list(): readonly Processor[];
  get(id: string): Processor | undefined;
  add(processor: Processor): () => void;
  match(event: CopilotzEvent, data?: unknown): readonly Processor[];
}>;

/** Connection-bound processors. Same contract as static, no delivery rows. */
export function createTransientProcessorSet(
  initial: readonly Processor[] = [],
): TransientProcessorSet {
  const processors: Processor[] = [...initial];
  return ({
    list() {
      return ([...processors] as const);
    },
    get(id) {
      return processors.find((processor) => processor.id === id);
    },
    add(processor) {
      const existing = processors.findIndex((item) => item.id === processor.id);
      if (existing >= 0) processors.splice(existing, 1);
      processors.push(processor);
      return () => {
        const index = processors.indexOf(processor);
        if (index >= 0) processors.splice(index, 1);
      };
    },
    match(event, data) {
      return (processors.filter((processor) =>
        matchProcessor(processor, event, data)
      ));
    },
  } as const);
}
