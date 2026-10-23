import {
  exportOwnerBundle,
  importOwnerBundle,
  type OwnerTransferConfig,
} from "./owner-bundle.ts";

/**
 * Copy a drained tenant schema to another database, preserving its authenticated
 * name and replay history. The source and bundle remain available for recovery;
 * the caller owns cutover and source retirement. The directory must not exist.
 */
export async function relocateOwnerSchema(input: {
  sourceUrl: string;
  destinationUrl: string;
  schema: string;
  directory: string;
  config: OwnerTransferConfig;
}): Promise<void> {
  await exportOwnerBundle({
    url: input.sourceUrl,
    schema: input.schema,
    directory: input.directory,
    config: input.config,
  });
  await importOwnerBundle({
    url: input.destinationUrl,
    directory: input.directory,
    adapter: input.config.destinationAdapter,
  });
}
