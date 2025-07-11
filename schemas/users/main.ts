import { pgTable, serial, text, jsonb } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';
import { relations } from 'npm:drizzle-orm';
import { subscriptions } from '../subscriptions/main.ts';

export const users = pgTable('users', {
    _id: serial('_id').primaryKey(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    email: text('email').notNull().unique(),
    context: jsonb('context'),
});

export const usersRelations = relations(users, ({ many }) => ({
    subscriptions: many(subscriptions),
}));

const insertUserSchema = createInsertSchema(users);
const selectUserSchema = createSelectSchema(users);
const updateUserSchema = createUpdateSchema(users);

// @ts-ignore - schema warning
export type User = z.infer<typeof selectUserSchema>;
// @ts-ignore - schema warning
export type InsertUser = z.infer<typeof insertUserSchema>;
// @ts-ignore - schema warning
export type UpdateUser = z.infer<typeof updateUserSchema>;

export default users; 