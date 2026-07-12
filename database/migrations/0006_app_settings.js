// PROJECT_PLAN.md Section 4, "Runtime Configuration". Non-secret operational
// settings only — never API keys/tokens (Section 3, Secrets & Configuration).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_by UUID REFERENCES users(id),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS app_settings');
}
