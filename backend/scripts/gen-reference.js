// Regenerates docs/reference/api-routes.md and docs/reference/database-schema.md from the code and the live database,
// so the reference documentation cannot drift from what the application really does.
//   cd backend && node scripts/gen-reference.js        (needs DATABASE_URL; run after migrations)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '..', 'docs', 'reference');
fs.mkdirSync(OUT, { recursive: true });

const MOUNTS = [
  ['profilePhoto', '/auth/profile/photo', 'Signed in'], ['auth', '/auth'], ['activities', '/activities'], ['analytics', '/analytics', 'Faculty / Admin'],
  ['portfolio', '/portfolio'], ['support#user', '/support', 'Signed in'], ['support#admin', '/admin/support', 'Admin'],
  ['adminOnboarding', '/admin', 'Admin'], ['adminFaculty', '/admin', 'Admin'], ['adminAcademic', '/admin', 'Admin'], ['admin', '/admin', 'Admin'],
  ['notifications', '/notifications', 'Signed in'],
];

function describe(line) {
  return line.replace(/^\s*(\/\*\*|\*|\/\/)\s?/, '').replace(/\*\/\s*$/, '').trim();
}

function routes() {
  const rows = [{ m: 'GET', p: '/health', access: 'Public', doc: 'Liveness check (no secrets, no database access).' }];
  for (const [name, prefix, routerAccess] of MOUNTS) {
    const file = name.split('#')[0];
    const lines = fs.readFileSync(path.join(ROOT, 'src/routes', `${file}.js`), 'utf8').split('\n');
    const re = name === 'support#user' ? /^userRouter\.(get|post|put|patch|delete)\(\s*'([^']*)'/
      : name === 'support#admin' ? /^adminRouter\.(get|post|put|patch|delete)\(\s*'([^']*)'/
        : /^\s*router\.(get|post|put|patch|delete)\(\s*(?:'([^']*)'|`([^`]*)`)/;
    lines.forEach((l, i) => {
      const m = re.exec(l);
      if (!m) return;
      const ctx = `${l}${lines[i + 1] || ''}`;
      let sub = m[2] ?? m[3];
      const kindRoute = /\$\{kind\.path\}/.test(sub);
      const subs = kindRoute ? ['students', 'faculty'].map((k) => sub.replace('${kind.path}', k)) : [sub];
      let access = routerAccess;
      if (!access) {
        if (/requireSuperAdmin/.test(ctx)) access = 'Super Admin';
        else if (/studentUpload|requireRole\('student'\)/.test(ctx)) access = 'Student';
        else if (/requireRole\('faculty', 'admin'\)|decide\(/.test(ctx)) access = 'Faculty / Admin';
        else if (/requireAuth/.test(ctx)) access = 'Signed in';
        else access = 'Public';
      }
      if (/requireSuperAdmin/.test(ctx)) access = 'Super Admin';
      let doc = '';
      for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
        const t = lines[k].trim();
        if (/^(\/\*\*|\*|\/\/)/.test(t)) { const d = describe(t); if (/^(GET|POST|PUT|PATCH|DELETE)\b/.test(d)) { doc = d.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+\S+\s*(-\s*)?/, ''); break; } } else if (t !== '') break;
      }
      for (const s of subs) rows.push({ m: m[1].toUpperCase(), p: (prefix + (s === '/' ? '' : s)) || prefix, access, doc: kindRoute ? `${doc || 'CSV import step'} (${s.split('/')[1]})` : doc });
    });
  }
  return rows;
}

async function schema() {
  const names = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
  let md = '# Database schema (generated)\n\nGenerated from the live database by `backend/scripts/gen-reference.js`. Do not edit by hand.\n\n';
  const applied = (await pool.query('SELECT name FROM schema_migrations ORDER BY name').catch(() => ({ rows: [] }))).rows.map((r) => r.name);
  md += `Applied migrations: ${applied.map((n) => `\`${n}\``).join(', ')}\n\n`;
  for (const n of names) {
    const cols = (await pool.query(`SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [n])).rows;
    const cons = (await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ('public.' || $1)::regclass ORDER BY contype, conname`, [n])).rows;
    const idx = (await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY 1`, [n])).rows;
    const trg = (await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = ('public.' || $1)::regclass AND NOT tgisinternal ORDER BY 1`, [n])).rows;
    md += `## \`${n}\`\n\n| Column | Type | Null | Default |\n|---|---|---|---|\n`;
    for (const c of cols) md += `| \`${c.column_name}\` | ${c.data_type}${c.character_maximum_length ? `(${c.character_maximum_length})` : ''} | ${c.is_nullable === 'YES' ? 'yes' : 'no'} | ${c.column_default ? `\`${String(c.column_default).replace(/\|/g, '\\|').slice(0, 60)}\`` : ''} |\n`;
    if (cons.length) md += `\nConstraints:\n${cons.map((c) => `- \`${c.conname}\`: ${c.def.replace(/\|/g, '\\|')}`).join('\n')}\n`;
    if (idx.length) md += `\nIndexes: ${idx.map((i) => `\`${i.indexname}\``).join(', ')}\n`;
    if (trg.length) md += `\nTriggers: ${trg.map((t) => `\`${t.tgname}\``).join(', ')}\n`;
    md += '\n';
  }
  return md;
}

(async () => {
  const rows = routes();
  let md = '# HTTP API reference (generated)\n\nGenerated from the route files by `backend/scripts/gen-reference.js`. Access is the guard the code applies; the database role is always the source of truth.\n\n| Method | Path | Access | Purpose |\n|---|---|---|---|\n';
  for (const r of rows) md += `| \`${r.m}\` | \`${r.p}\` | ${r.access} | ${(r.doc || '').replace(/\|/g, '\\|')} |\n`;
  md += `\n${rows.length} endpoints.\n`;
  fs.writeFileSync(path.join(OUT, 'api-routes.md'), md);
  fs.writeFileSync(path.join(OUT, 'database-schema.md'), await schema());
  console.log(`wrote ${rows.length} routes and the schema to docs/reference`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
