export type CollectionPolicyRegistration = Readonly<{
  alias: string;
  name: string;
  evaluate: ReturnType<typeof import("./evaluator.ts").createOwnerEvaluator>;
  reference: import("./authority.ts").AuthorityPolicy;
}>;
export type CollectionPolicyRegistrations = ReadonlyMap<
  string,
  CollectionPolicyRegistration
>;
