/**
 * Framework-independent participant helpers.
 *
 * Participants are stored as graph nodes and can represent humans or agents.
 * Metadata for the participant lives on the node and is merged on update.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";

export type ParticipantData = Record<string, unknown>;

export interface ParticipantGetOptions {
  namespace?: string | null;
}

export interface ParticipantUpdateOptions extends ParticipantGetOptions {
  participantType?: "human" | "agent";
  replaceKeys?: string[];
  name?: string | null;
  email?: string | null;
  agentId?: string | null;
}

function deepMergeReplaceArrays(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMergeReplaceArrays(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

function getParticipantMetadata(
  node: Awaited<ReturnType<Copilotz["ops"]["getParticipantNode"]>>,
) {
  return ((node?.data?.metadata ?? node?.data) ?? {}) as ParticipantData;
}

export interface ParticipantHandlers {
  get: (
    externalId: string,
    options?: ParticipantGetOptions,
  ) => Promise<ParticipantData | null>;
  update: (
    externalId: string,
    updates: ParticipantData,
    options?: ParticipantUpdateOptions,
  ) => Promise<ParticipantData>;
}

export function createParticipantHandlers(
  copilotz: Copilotz,
): ParticipantHandlers {
  const { ops } = copilotz;

  return {
    get: async (externalId, options = {}) => {
      const participantNode = await ops.getParticipantNode(
        externalId,
        options.namespace ?? null,
      );
      if (!participantNode) return null;
      return getParticipantMetadata(participantNode);
    },

    update: async (externalId, updates, options = {}) => {
      const namespace = options.namespace ?? null;
      const current = await ops.getParticipantNode(externalId, namespace);
      const currentMetadata = getParticipantMetadata(current);
      const next = deepMergeReplaceArrays(currentMetadata, updates);

      for (const key of options.replaceKeys ?? []) {
        if (key in updates) {
          next[key] = updates[key];
        }
      }

      next.updatedAt = new Date().toISOString();

      await ops.upsertParticipantNode(
        externalId,
        options.participantType ?? "human",
        namespace,
        {
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.email !== undefined ? { email: options.email } : {}),
          ...(options.agentId !== undefined
            ? { agentId: options.agentId }
            : {}),
          metadata: next,
        },
      );

      return next;
    },
  };
}
