/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP EXTENSION IF EXISTS "uuid-ossp"');
}
