/**
 * Three contexts (for agents with memory): how to use it, in the system text
 * as Copilotz's own instructions (fixed words, never what anyone wrote); what
 * it has in mind about who's here, told when a conversation begins (the same
 * in every conversation's system text, so cached across them); and what's
 * relevant to the latest message, each turn. The last two are what people and
 * agents wrote: information, never instructions.
 */
export const contexts = {
  memory: { place: "system", instructions: true },
  remembered: { place: "turn" },
  recall: { place: "turn" },
};
