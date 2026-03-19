export const generateApiResponseHeaderMigrations = (): string => `
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "includeResponseHeaders" BOOLEAN;
`;
