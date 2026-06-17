/**
 * Framework-independent participant helpers.
 *
 * Participants are stored as graph nodes and can represent humans, agents, or jobs.
 * Metadata for the participant lives on the node and is merged on update.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";

/** Serializable participant profile data stored on a graph node. */
export type ParticipantData = Record<string, unknown>;

/** Options for reading a participant profile. */
export interface ParticipantGetOptions {
  namespace?: string | null;
}

/** Options for updating a participant profile. */
export interface ParticipantUpdateOptions extends ParticipantGetOptions {
  participantType?: "human" | "agent" | "job";
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

/** Handlers for reading and updating participant profiles by external ID. */
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

/** Creates framework-independent participant profile handlers. */
export function createParticipantHandlers(
  copilotz: Copilotz,
): ParticipantHandlers {
  return {
    get: async (externalId, options = {}) => {
      const namespace = options.namespace ?? copilotz.config.namespace;
      if (!namespace) return null;
      const participantCollection = copilotz.collections?.withNamespace(
        namespace,
      ).participant;
      if (
        !participantCollection ||
        typeof (participantCollection as any).resolveByExternalId !== "function"
      ) return null;

      const participant = await (participantCollection as any)
        .resolveByExternalId(externalId);
      if (!participant) return null;
      return participant as ParticipantData;
    },

    update: async (externalId, updates, options = {}) => {
      const namespace = options.namespace ?? copilotz.config.namespace;
      if (!namespace) {
        throw new Error("Participant namespace is required");
      }
      const participantCollection = copilotz.collections?.withNamespace(
        namespace,
      ).participant;
      if (
        !participantCollection ||
        typeof (participantCollection as any).resolveByExternalId !== "function"
      ) {
        throw new Error("Participant collection is not available");
      }

      const current = await (participantCollection as any).resolveByExternalId(
        externalId,
      );
      const currentMetadata = (current?.metadata ?? {}) as ParticipantData;
      const next = deepMergeReplaceArrays(currentMetadata, updates);

      for (const key of options.replaceKeys ?? []) {
        if (key in updates) {
          next[key] = updates[key];
        }
      }

      next.updatedAt = new Date().toISOString();

      const participant = await (participantCollection as any).upsertIdentity({
        externalId,
        participantType: options.participantType ?? "human",
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.email !== undefined ? { email: options.email } : {}),
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        metadata: next,
      });

      return participant as ParticipantData;
    },
  };
}
