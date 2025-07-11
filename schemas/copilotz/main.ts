import { pgTable, serial, text, integer, jsonb } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';
import { relations } from 'npm:drizzle-orm';
import { jobs } from '../jobs/main.ts';
import { subscriptions } from '../subscriptions/main.ts';

export const copilotz = pgTable('copilotz', {
    _id: serial('_id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    backstory: text('backstory').notNull(),
    job: integer('job'), // Reference to jobs table
    actions: jsonb('actions').notNull(), // Array of action IDs as JSON
    configs: jsonb('configs').notNull(), // Array of config IDs as JSON
    workflows: jsonb('workflows').notNull(), // Array of workflow IDs as JSON
});

export const copilotzRelations = relations(copilotz, ({ one, many }) => ({
    job: one(jobs, {
        fields: [copilotz.job],
        references: [jobs._id],
    }),
    subscriptions: many(subscriptions),
}));

const insertCopilotzSchema = createInsertSchema(copilotz);
const selectCopilotzSchema = createSelectSchema(copilotz);
const updateCopilotzSchema = createUpdateSchema(copilotz);

// @ts-ignore - schema warning
export type Copilotz = z.infer<typeof selectCopilotzSchema>;
// @ts-ignore - schema warning
export type InsertCopilotz = z.infer<typeof insertCopilotzSchema>;
// @ts-ignore - schema warning
export type UpdateCopilotz = z.infer<typeof updateCopilotzSchema>;

export default copilotz;