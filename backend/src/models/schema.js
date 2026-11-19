// Kept for backward compatibility: server.js and the test suite call initSchema().
// The schema itself now lives in versioned files under src/migrations/.
const { runMigrations } = require('../migrations');

async function initSchema() {
  const applied = await runMigrations();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
}

module.exports = { initSchema };
