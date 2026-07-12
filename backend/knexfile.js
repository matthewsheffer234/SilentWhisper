import 'dotenv/config';

// Migrations connect with the admin/migration credentials (PG*), which can
// CREATE ROLE and GRANT — distinct from the least-privilege APP_DB_USER the
// running app connects as (see src/db.js and PROJECT_PLAN.md Section 5).
export default {
  client: 'pg',
  connection: {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  },
  migrations: {
    directory: '../database/migrations',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: '../database/seeds',
  },
};
