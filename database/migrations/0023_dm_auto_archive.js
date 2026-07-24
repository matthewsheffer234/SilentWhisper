// FEATURE_REQUEST.md entry 2: per-user auto-archive threshold for
// DIRECT/GROUP_DM channels. NULL (the default for every existing and
// newly created row) means "use the system default"
// (config.dm.autoArchiveDefaultDays); an explicit 0 means "never archive";
// any positive integer overrides the default. No archived_at/status column
// anywhere — dormancy is always computed live from each channel's actual
// last-activity timestamp against this threshold (see routes/directMessages.js),
// never stored, so there is nothing here for a second system of record to
// drift out of sync with.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.integer('dm_auto_archive_days').nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('dm_auto_archive_days');
  });
}
