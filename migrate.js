// Run once against a fresh Postgres database:
//   npm run migrate
// Reads the connection string from DATABASE_URL in .env (or the environment).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Create a .env file (see .env.example) with your connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
pool.on('error', (err) => console.error('Pool error during migration (non-fatal):', err.message));

async function main() {
  console.log('Creating tables...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const { rows: existing } = await pool.query('SELECT COUNT(*) FROM leads');
  if (Number(existing[0].count) > 0) {
    console.log(`Database already has ${existing[0].count} leads — skipping seed data. Tables are ready.`);
    await pool.end();
    return;
  }

  console.log('Seeding sample data...');
  const sources = ['Salesforce', 'HubSpot', 'CSV', 'Manual', 'Website', 'Referral'];
  const sourceIds = {};
  for (const name of sources) {
    const { rows } = await pool.query('INSERT INTO lead_sources (name) VALUES ($1) RETURNING id', [name]);
    sourceIds[name] = rows[0].id;
  }

  const users = [
    { id: uuid(), email: 'priya.nair@lodestar.io', name: 'Priya Nair', role: 'admin' },
    { id: uuid(), email: 'arjun.mehta@lodestar.io', name: 'Arjun Mehta', role: 'sales_manager' },
    { id: uuid(), email: 'sara.lindqvist@lodestar.io', name: 'Sara Lindqvist', role: 'sales_rep' },
    { id: uuid(), email: 'dev.kapoor@lodestar.io', name: 'Dev Kapoor', role: 'sales_rep' },
  ];
  for (const u of users) {
    await pool.query('INSERT INTO users (id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5)',
      [u.id, u.email, u.name, u.role, 'demo-hash']);
  }
  const userByName = Object.fromEntries(users.map(u => [u.name, u.id]));

  const tagNames = ['enterprise', 'hot', 'trial', 'referral', 'high-value'];
  const tagIds = {};
  for (const name of tagNames) {
    const { rows } = await pool.query('INSERT INTO tags (name) VALUES ($1) RETURNING id', [name]);
    tagIds[name] = rows[0].id;
  }

  const leadsData = [
    { firstName: 'Meera', lastName: 'Kapoor', email: 'meera.kapoor@arclight.io', phone: '+91 98100 22345', company: 'Arclight Systems', jobTitle: 'VP Marketing', source: 'Salesforce', status: 'qualified', priority: 'high', owner: 'Arjun Mehta', deal: 45000, tags: ['enterprise', 'hot'] },
    { firstName: 'Ravi', lastName: 'Desai', email: 'ravi.desai@northbridge.com', phone: '+91 98200 11223', company: 'Northbridge Capital', jobTitle: 'Director of Ops', source: 'Salesforce', status: 'new', priority: 'medium', owner: 'Arjun Mehta', deal: 12000, tags: [] },
    { firstName: 'Sara', lastName: 'Lindqvist', email: 'sara.l@havenware.com', phone: '+46 70 123 4567', company: 'Havenware', jobTitle: 'Head of Growth', source: 'HubSpot', status: 'contacted', priority: 'medium', owner: 'Dev Kapoor', deal: 8000, tags: ['trial'] },
    { firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.com', phone: '+1 555 0100', company: 'Acme Inc', jobTitle: 'CTO', source: 'CSV', status: 'new', priority: 'low', owner: null, deal: null, tags: [] },
    { firstName: 'Tom', lastName: 'Reyes', email: 'tom.reyes@brightpath.com', phone: '+1 555 0142', company: 'BrightPath Consulting', jobTitle: 'Founder', source: 'Manual', status: 'unqualified', priority: 'low', owner: 'Sara Lindqvist', deal: 2000, tags: [] },
    { firstName: 'Aisha', lastName: 'Rahman', email: 'aisha@velocity.com', phone: '+91 90000 44556', company: 'Velocity Retail', jobTitle: 'Head of Procurement', source: 'Website', status: 'qualified', priority: 'high', owner: 'Sara Lindqvist', deal: 60000, tags: ['high-value', 'referral'] },
    { firstName: 'Meera', lastName: 'Kapoor', email: 'meera.kapoor@arclight.io', phone: '+91 98100 22345', company: 'Arclight Systems', jobTitle: 'VP Marketing', source: 'CSV', status: 'duplicate', priority: 'medium', owner: null, deal: null, tags: [] },
  ];

  const leadIds = [];
  for (const l of leadsData) {
    const id = uuid();
    leadIds.push(id);
    await pool.query(`
      INSERT INTO leads (id, first_name, last_name, email, phone, company, job_title, lead_source_id, owner_id, status, priority, expected_deal_size)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [id, l.firstName, l.lastName, l.email, l.phone, l.company, l.jobTitle, sourceIds[l.source], l.owner ? userByName[l.owner] : null, l.status, l.priority, l.deal]);
    for (const t of l.tags) {
      await pool.query('INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1,$2)', [id, tagIds[t]]);
    }
    await pool.query('INSERT INTO lead_activities (id, lead_id, action, detail) VALUES ($1,$2,$3,$4)',
      [uuid(), id, 'Created', `Imported via ${l.source}`]);
  }
  await pool.query('UPDATE leads SET duplicate_of = $1 WHERE id = $2', [leadIds[0], leadIds[6]]);
  await pool.query('INSERT INTO lead_notes (id, lead_id, author_id, body) VALUES ($1,$2,$3,$4)',
    [uuid(), leadIds[0], userByName['Arjun Mehta'], 'Had a great call — sending proposal Friday.']);

  const jobId = uuid();
  await pool.query(`
    INSERT INTO import_jobs (id, source, file_name, imported_by, status, total_rows, success_count, failed_count, duplicate_count, started_at, completed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now())
  `, [jobId, 'csv', 'leads-batch-march.csv', userByName['Priya Nair'], 'completed', 5, 4, 1, 1]);
  await pool.query('INSERT INTO import_errors (id, import_job_id, row_number, reason, raw_row) VALUES ($1,$2,$3,$4,$5)',
    [uuid(), jobId, 4, 'Missing both email and phone', JSON.stringify({ 'First Name': 'Unknown', Company: '???' })]);

  await pool.query("INSERT INTO duplicate_rules (id, match_fields, action, priority) VALUES ($1,'email','flag',1)", [uuid()]);
  await pool.query("INSERT INTO duplicate_rules (id, match_fields, action, priority) VALUES ($1,'phone','flag',2)", [uuid()]);
  await pool.query("INSERT INTO duplicate_rules (id, match_fields, action, priority) VALUES ($1,'company,first_name,last_name','flag',3)", [uuid()]);

  console.log('Done. Seeded', leadsData.length, 'leads,', users.length, 'users.');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
