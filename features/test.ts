
import { drizzle } from 'npm:drizzle-orm/pg-proxy'

export default async function test(data: any, context: any) {

    const { dependencies } = context;

    const { withDrizzle, schema } = dependencies.ominipg;

    const db = await withDrizzle(drizzle);

    const result = await db.select().from(schema.actions);

    return result
}