const { Pool, types } = require('pg');

// A DATE has no time zone. Keep it as the plain string 'YYYY-MM-DD' (the default parser turns it into a
// local-midnight JS Date, which shifts the day in some time zones).
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

module.exports = pool;
