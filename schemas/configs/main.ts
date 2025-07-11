

import { pgTable, serial, text, jsonb, integer, boolean as pgBoolean } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';



export const configs = pgTable('configs', {
    _id: serial('_id').primaryKey(),
    name: text('name').notNull(),
    value: jsonb('value'),
    owner: integer('owner').notNull(),
    ownerType: text('ownerType').notNull(),
    isSecret: pgBoolean('isSecret'),
});

const insertConfigSchema = createInsertSchema(configs);
const selectConfigSchema = createSelectSchema(configs);
const updateConfigSchema = createUpdateSchema(configs);

// @ts-ignore - schema warning
export type Config = z.infer<typeof selectConfigSchema>;
// @ts-ignore - schema warning
export type InsertConfig = z.infer<typeof insertConfigSchema>;
// @ts-ignore - fix this
export type UpdateConfig = z.infer<typeof updateConfigSchema>;

export default configs;