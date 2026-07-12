import 'dotenv/config';

function required(name, value) {
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8000),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  db: {
    // Least-privilege runtime role (Section 5, Database Access Rights).
    // Migrations run separately using PG*-prefixed admin credentials — see knexfile.js.
    host: required('PGHOST', process.env.PGHOST),
    port: Number(process.env.PGPORT || 5432),
    user: required('APP_DB_USER', process.env.APP_DB_USER),
    password: required('APP_DB_PASSWORD', process.env.APP_DB_PASSWORD),
    database: required('PGDATABASE', process.env.PGDATABASE),
    // Scalability Target (PROJECT_PLAN.md Section 2): default to 20, not
    // sized 1:1 with concurrent users — Node's event loop multiplexes many
    // connections through a small pool.
    poolMin: Number(process.env.PG_POOL_MIN || 2),
    poolMax: Number(process.env.PG_POOL_MAX || 20),
  },
};
