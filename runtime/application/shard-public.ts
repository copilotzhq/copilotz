/** Pinned connection hosting and stateless controller capabilities. */
export { createCopilotzShard, shardForActor } from "./shard.ts";
export type {
  CopilotzShard,
  CreateCopilotzShardOptions,
  ShardActor,
  ShardOwnerBinding,
  ShardPrincipal,
  ShardWorkerKind,
  ShardWorkInput,
} from "./shard.ts";
export {
  createShardController,
  createShardControllerHandler,
  SHARD_WORK_PATH,
  ShardDispatchError,
} from "./shard-controller.ts";
export {
  connectShardOwner,
  SHARD_OWNER_WORKLOAD,
  shardOwnerCalls,
} from "./shard-owner.ts";
export {
  connectShardDispatcher,
  createShardDispatcher,
} from "./shard-relay.ts";

export type { ShardOwnerConnection } from "./shard-owner.ts";
export type {
  ShardDispatcher,
  ShardDispatcherConnection,
} from "./shard-relay.ts";
export { createShardWorker } from "./shard-worker.ts";
