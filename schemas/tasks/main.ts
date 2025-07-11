import { pgTable, serial, text, integer, jsonb } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';
import { relations } from 'npm:drizzle-orm';
import { workflows } from '../workflows/main.ts';
import { steps } from '../steps/main.ts';

export const tasks = pgTable('tasks', {
    _id: serial('_id').primaryKey(),
    extId: text('extId').notNull().unique(), // Required and unique
    workflow: integer('workflow'), // Reference to workflows table
    currentStep: integer('currentStep'), // Reference to steps table
    status: text('status').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    context: jsonb('context'), // Any type as JSON
});

export const tasksRelations = relations(tasks, ({ one }) => ({
    workflow: one(workflows, {
        fields: [tasks.workflow],
        references: [workflows._id],
    }),
    currentStep: one(steps, {
        fields: [tasks.currentStep],
        references: [steps._id],
    }),
}));

const insertTaskSchema = createInsertSchema(tasks);
const selectTaskSchema = createSelectSchema(tasks);
const updateTaskSchema = createUpdateSchema(tasks);

// @ts-ignore - schema warning
export type Task = z.infer<typeof selectTaskSchema>;
// @ts-ignore - schema warning
export type InsertTask = z.infer<typeof insertTaskSchema>;
// @ts-ignore - schema warning
export type UpdateTask = z.infer<typeof updateTaskSchema>;

export default tasks; 