/**
 * Three contexts (for agents with memory): how to use it, in the system text;
 * what it has in mind about who's here, told when a conversation begins (the
 * same in every conversation's system text, so cached across them); and
 * what's relevant to the latest message, each turn.
 */
export const contexts = {
  memory: { place: "system" },
  remembered: { place: "turn" },
  recall: { place: "turn" },
};
