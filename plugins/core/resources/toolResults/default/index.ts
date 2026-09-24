/** Default Core policy for large historical Tool results. @module */

export type ToolResultPolicy = Readonly<{
  /** Tool result bodies above this size are represented by a retrieval marker. */
  maxInlineBytes: number;
  /** Maximum bytes returned by one explicit readToolResult call. */
  maxReadBytes: number;
  /** Maximum text/JSON source bytes materialized by one explicit read. */
  maxSourceBytes: number;
}>;

export const defaultToolResultPolicy: ToolResultPolicy = {
  maxInlineBytes: 10 * 1024,
  maxReadBytes: 16 * 1024,
  maxSourceBytes: 16 * 1024 * 1024,
};

export default defaultToolResultPolicy;
