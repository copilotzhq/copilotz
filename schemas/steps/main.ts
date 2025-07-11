import { pgTable, serial, text, integer, jsonb } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';
import { relations } from 'npm:drizzle-orm';
import { jobs } from '../jobs/main.ts';
import { tasks } from '../tasks/main.ts';

export const steps = pgTable('steps', {
    _id: serial('_id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    instructions: text('instructions').notNull(),
    submitWhen: text('submitWhen').notNull(),
    onSubmit: integer('onSubmit'), // Reference to actions table
    job: integer('job'), // Reference to jobs table
    actions: jsonb('actions').notNull(), // Array of action IDs as JSON
    next: integer('next'), // Reference to steps table (self-reference)
});

export const stepsRelations = relations(steps, ({ one, many }) => ({
    job: one(jobs, {
        fields: [steps.job],
        references: [jobs._id],
    }),
    next: one(steps, {
        fields: [steps.next],
        references: [steps._id],
    }),
    tasks: many(tasks),
}));

const insertStepSchema = createInsertSchema(steps);
const selectStepSchema = createSelectSchema(steps);
const updateStepSchema = createUpdateSchema(steps);

// @ts-ignore - schema warning
export type Step = z.infer<typeof selectStepSchema>;
// @ts-ignore - schema warning
export type InsertStep = z.infer<typeof insertStepSchema>;
// @ts-ignore - schema warning
export type UpdateStep = z.infer<typeof updateStepSchema>;

export default steps; 