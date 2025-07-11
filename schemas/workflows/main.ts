import { pgTable, serial, text, integer, jsonb } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';
import { relations } from 'npm:drizzle-orm';
import { steps } from '../steps/main.ts';
import { tasks } from '../tasks/main.ts';
import { jobs } from '../jobs/main.ts';

export const workflows = pgTable('workflows', {
    _id: serial('_id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    instructions: text('instructions').notNull(),
    steps: jsonb('steps').notNull(), // Array of step IDs as JSON
    firstStep: integer('firstStep'), // Reference to steps table
});

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
    firstStep: one(steps, {
        fields: [workflows.firstStep],
        references: [steps._id],
    }),
    tasks: many(tasks),
    jobs: many(jobs),
}));

const insertWorkflowSchema = createInsertSchema(workflows);
const selectWorkflowSchema = createSelectSchema(workflows);
const updateWorkflowSchema = createUpdateSchema(workflows);

// @ts-ignore - schema warning  
export type Workflow = z.infer<typeof selectWorkflowSchema>;
// @ts-ignore - schema warning
export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
// @ts-ignore - schema warning
export type UpdateWorkflow = z.infer<typeof updateWorkflowSchema>;

export default workflows; 