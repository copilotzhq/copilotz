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
}>;

/** Runtime-neutral lazy representation of one Agent Skills directory. */
export type Skill =
  & SkillManifest
  & Readonly<{
    files: readonly SkillFileDescriptor[];
    read(path: string, options?: SkillReadOptions): Promise<SkillFile>;
  }>;

export type SkillIndexEntry = Pick<
  SkillManifest,
  "name" | "description" | "compatibility"
>;
