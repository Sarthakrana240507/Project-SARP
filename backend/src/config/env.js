// Validates required environment variables once at startup.
// Failing fast is safer than running with a weak or missing secret.
function checkEnv() {
  const problems = [];
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is not set');
  const secret = process.env.JWT_SECRET || '';
  if (!secret) problems.push('JWT_SECRET is not set');
  else if (secret.length < 32) {
    const msg = 'JWT_SECRET should be at least 32 characters';
    if (process.env.NODE_ENV === 'production') problems.push(msg);
    else console.warn(`Warning: ${msg}`);
  }
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
}

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

module.exports = { checkEnv, JWT_EXPIRES_IN };
