require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Create a .env file (copy .env.example) with your Postgres connection string, then run: npm run migrate');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,                     // free-tier Postgres hosts cap concurrent connections low
  idleTimeoutMillis: 10000,   // release idle connections quickly instead of holding them open
  connectionTimeoutMillis: 10000,
});

// IMPORTANT: without this handler, a background connection hiccup (e.g. a
// serverless database like Neon suspending an idle connection) crashes the
// entire Node process silently instead of just logging the problem.
pool.on('error', (err) => {
  console.error('Unexpected database error on an idle client (server keeps running):', err.message);
});

module.exports = pool;
