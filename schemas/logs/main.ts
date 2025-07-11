import { pgTable, serial, text, jsonb, integer, boolean as pgBoolean } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';

export const logs = pgTable('logs', {
    _id: serial('_id').primaryKey(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    requestId: text('requestId').notNull(),
    executionId: text('executionId').notNull(),
    tags: jsonb('tags'),
    input: jsonb('input'),
    output: jsonb('output'),
    duration: integer('duration'),
    status: text('status').notNull(), // started, completed, failed
    hidden: pgBoolean('hidden'),
});

const insertLogSchema = createInsertSchema(logs);
const selectLogSchema = createSelectSchema(logs);
const updateLogSchema = createUpdateSchema(logs);

// @ts-ignore - schema warning
export type Log = z.infer<typeof selectLogSchema>;
// @ts-ignore - schema warning
export type InsertLog = z.infer<typeof insertLogSchema>;
// @ts-ignore - schema warning
export type UpdateLog = z.infer<typeof updateLogSchema>;

export default logs; 