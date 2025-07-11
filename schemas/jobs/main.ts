import { pgTable, serial, text, integer, jsonb } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';
import { relations } from 'npm:drizzle-orm';
import { workflows } from '../workflows/main.ts';
import { steps } from '../steps/main.ts';
import { copilotz } from '../copilotz/main.ts';

export const jobs = pgTable('jobs', {
    _id: serial('_id').primaryKey(),
    description: text('description').notNull(),
    role: text('role').notNull(),
    goal: text('goal').notNull(),
    actions: jsonb('actions').notNull(), // Array of action IDs as JSON
    defaultWorkflow: integer('defaultWorkflow'), // Reference to workflows table
    workflows: jsonb('workflows').notNull(), // Array of workflow IDs as JSON
});

export const jobsRelations = relations(jobs, ({ one, many }) => ({
    defaultWorkflow: one(workflows, {
        fields: [jobs.defaultWorkflow],
        references: [workflows._id],
    }),
    steps: many(steps),
    copilotz: many(copilotz),
}));

const insertJobSchema = createInsertSchema(jobs);
const selectJobSchema = createSelectSchema(jobs);
const updateJobSchema = createUpdateSchema(jobs);

// @ts-ignore - schema warning
export type Job = z.infer<typeof selectJobSchema>;
// @ts-ignore - schema warning
export type InsertJob = z.infer<typeof insertJobSchema>;
// @ts-ignore - schema warning
export type UpdateJob = z.infer<typeof updateJobSchema>;

export default jobs;