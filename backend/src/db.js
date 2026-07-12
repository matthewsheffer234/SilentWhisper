import knexFactory from 'knex';
import { config } from './config.js';

// Runtime connection pool — connects as the least-privilege app_runtime_user
// role (see /database/migrations grants migration and PROJECT_PLAN.md
// Section 5), never as the migration/admin user.
export const db = knexFactory({
  client: 'pg',
  connection: {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  },
  pool: {
    min: config.db.poolMin,
    max: config.db.poolMax,
  },
});

export async function checkDbConnection() {
  await db.raw('SELECT 1');
}
