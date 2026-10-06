/** Agent Skills specification metadata parsed from `SKILL.md`. */
export type SkillManifest = Readonly<{
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Readonly<Record<string, string>>;
  /** Experimental spec field. It describes compatibility, not authority. */
  allowedTools?: string;
}>;

export type SkillFileDescriptor = Readonly<{
  /** Portable, slash-separated path relative to the skill root. */
  path: string;
  mediaType: string;
  size?: number;
  /** Content digest such as `sha256:<hex>`. */
  digest?: string;
}>;

export type SkillFileBody =
  | string
  | Uint8Array
  | ReadableStream<Uint8Array>;

export type SkillFile =
  & SkillFileDescriptor
  & Readonly<{
    body: SkillFileBody;
  }>;

export type SkillReadOptions = Readonly<{
  signal?: AbortSignal;
  maximumTextBytes?: number;
  /** App-owned namespace object; completed snapshots never cross app scopes. */
  scope?: object;
}>;

/** Runtime-neutral lazy representation of one Agent Skills directory. */
export type Skill =
  & Partial<SkillManifest>
  & Readonly<{
    name: string;
    files: readonly SkillFileDescriptor[];
    dynamicFiles?: boolean;
    load(
      options?: SkillReadOptions,
    ): Promise<import("./parser.ts").ParsedSkillMarkdown>;
    /** Optional real file/HTTP location for an externally readable Skill. */
    locator?: string;
    read(path: string, options?: SkillReadOptions): Promise<SkillFile>;
  }>;

export type SkillIndexEntry = Pick<
  SkillManifest,
  "name" | "description" | "compatibility"
>;
/**
 * Declares the public Skill Resource contracts.
 *
 * @module
 */
