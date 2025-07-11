import { pgTable, serial, text, integer } from 'npm:drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'npm:drizzle-zod';
import { z } from 'npm:zod';
import { relations } from 'npm:drizzle-orm';
import { users } from '../users/main.ts';
import { copilotz } from '../copilotz/main.ts';

export const subscriptions = pgTable('subscriptions', {
    _id: serial('_id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    user: integer('user'), // Reference to users table
    copilotz: integer('copilotz'), // Reference to copilotz table
    subscriptionId: text('subscriptionId').notNull(),
    paymentProvider: text('paymentProvider').notNull(), // only 'stripe' for now
});

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
    user: one(users, {
        fields: [subscriptions.user],
        references: [users._id],
    }),
    copilotz: one(copilotz, {
        fields: [subscriptions.copilotz],
        references: [copilotz._id],
    }),
}));

const insertSubscriptionSchema = createInsertSchema(subscriptions);
const selectSubscriptionSchema = createSelectSchema(subscriptions);
const updateSubscriptionSchema = createUpdateSchema(subscriptions);

// @ts-ignore - schema warning
export type Subscription = z.infer<typeof selectSubscriptionSchema>;
// @ts-ignore - schema warning
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
// @ts-ignore - schema warning
export type UpdateSubscription = z.infer<typeof updateSubscriptionSchema>;

export default subscriptions; 