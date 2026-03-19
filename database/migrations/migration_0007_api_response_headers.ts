export const generateApiResponseHeaderMigrations = (): string => `

IF EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = current_schema() AND table_name = 'apis'
) THEN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'apis'
      AND column_name = 'includeResponseHeaders'
  ) THEN
    ALTER TABLE "apis" ADD COLUMN "includeResponseHeaders" BOOLEAN;
  END IF;
END IF;
`;
