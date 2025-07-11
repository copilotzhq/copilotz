import { pgTable, text, jsonb } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';

export const actions = pgTable('actions', {
    _id: text('_id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    inputSchema: jsonb('inputSchema').notNull(),
    outputSchema: jsonb('outputSchema').notNull(),
    handler: jsonb('handler').notNull(),
    openAPISchema: jsonb('openAPISchema'),
    mcpServer: jsonb('mcpServer'),
});

const insertActionSchema = createInsertSchema(actions);
const selectActionSchema = createSelectSchema(actions);
const updateActionSchema = createUpdateSchema(actions);

// @ts-ignore - schema warning
export type Action = z.infer<typeof selectActionSchema>;
// @ts-ignore - schema warning
export type InsertAction = z.infer<typeof insertActionSchema>;
// @ts-ignore - schema warning
export type UpdateAction = z.infer<typeof updateActionSchema>;


export default actions; 