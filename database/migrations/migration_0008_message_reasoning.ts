export const generateMessageReasoningMigrations = (): string => `
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "reasoning" TEXT;
`;
