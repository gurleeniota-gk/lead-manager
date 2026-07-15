const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
// Serves just index.html at the root URL — deliberately not the whole
// directory (that would expose server.js, db.js, .env, etc. over HTTP).
const upload = multer({ storage: multer.memoryStorage() });

/* ---------------- helpers ---------------- */

async function findDuplicate(candidate, excludeId = null) {
  const { rows } = excludeId
    ? await pool.query('SELECT * FROM leads WHERE id != $1', [excludeId])
    : await pool.query('SELECT * FROM leads');
  return rows.find(l => {
    if (candidate.email && l.email && candidate.email.trim().toLowerCase() === l.email.trim().toLowerCase()) return true;
    if (candidate.phone && l.phone && candidate.phone.replace(/\D/g, '') && candidate.phone.replace(/\D/g, '') === l.phone.replace(/\D/g, '')) return true;
    if (candidate.company && candidate.first_name && candidate.last_name && l.company && l.first_name && l.last_name &&
        candidate.company.trim().toLowerCase() === l.company.trim().toLowerCase() &&
        candidate.first_name.trim().toLowerCase() === l.first_name.trim().toLowerCase() &&
        candidate.last_name.trim().toLowerCase() === l.last_name.trim().toLowerCase()) return true;
    return false;
  });
}

async function getOrCreateSourceId(name) {
  const { rows } = await pool.query('SELECT id FROM lead_sources WHERE name = $1', [name]);
  if (rows[0]) return rows[0].id;
  const ins = await pool.query('INSERT INTO lead_sources (name) VALUES ($1) RETURNING id', [name]);
  return ins.rows[0].id;
}

async function logActivity(leadId, action, detail) {
  await pool.query('INSERT INTO lead_activities (id, lead_id, action, detail) VALUES ($1,$2,$3,$4)', [uuid(), leadId, action, detail]);
}

// wraps async route handlers so thrown errors reach Express's error handler
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

/* ---------------- real HubSpot integration ---------------- */

const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';

async function fetchHubSpotContacts(limit = 20) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    const err = new Error('HUBSPOT_ACCESS_TOKEN is not set');
    err.code = 'NO_TOKEN';
    throw err;
  }
  const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts?limit=${limit}&properties=firstname,lastname,email,phone,company,jobtitle`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HubSpot API returned ${res.status}: ${text}`);
    err.code = 'API_ERROR';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.results || [];
}

/* ---------------- meta ---------------- */

app.get('/api/meta', ah(async (req, res) => {
  const sources = (await pool.query('SELECT name FROM lead_sources ORDER BY name')).rows.map(r => r.name);
  const owners = (await pool.query('SELECT id, name FROM users ORDER BY name')).rows;
  const statuses = ['new', 'contacted', 'qualified', 'unqualified', 'duplicate'];
  res.json({ sources, owners, statuses });
}));

/* ---------------- leads ---------------- */

app.get('/api/leads', ah(async (req, res) => {
  const { search = '', source = '', status = '', owner = '' } = req.query;
  let sql = `
    SELECT l.*, ls.name AS source_name, u.name AS owner_name
    FROM leads l
    LEFT JOIN lead_sources ls ON l.lead_source_id = ls.id
    LEFT JOIN users u ON l.owner_id = u.id
    WHERE 1=1`;
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    sql += ` AND (l.first_name ILIKE $${i} OR l.last_name ILIKE $${i} OR l.email ILIKE $${i} OR l.phone ILIKE $${i} OR l.company ILIKE $${i})`;
  }
  if (source) { params.push(source); sql += ` AND ls.name = $${params.length}`; }
  if (status) { params.push(status); sql += ` AND l.status = $${params.length}`; }
  if (owner) { params.push(owner); sql += ` AND u.id = $${params.length}`; }
  sql += ' ORDER BY l.created_at DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

app.get('/api/leads/:id', ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT l.*, ls.name AS source_name, u.name AS owner_name
    FROM leads l
    LEFT JOIN lead_sources ls ON l.lead_source_id = ls.id
    LEFT JOIN users u ON l.owner_id = u.id
    WHERE l.id = $1`, [req.params.id]);
  const lead = rows[0];
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  lead.activities = (await pool.query('SELECT * FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id])).rows;
  lead.notes = (await pool.query('SELECT * FROM lead_notes WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id])).rows;
  lead.tags = (await pool.query('SELECT t.name FROM tags t JOIN lead_tags lt ON lt.tag_id = t.id WHERE lt.lead_id = $1', [req.params.id])).rows.map(r => r.name);
  res.json(lead);
}));

app.post('/api/leads', ah(async (req, res) => {
  const b = req.body;
  const candidate = { email: b.email, phone: b.phone, company: b.company, first_name: b.firstName, last_name: b.lastName };
  const dupe = await findDuplicate(candidate);
  if (dupe && !b.force) {
    return res.status(409).json({ duplicateOf: { id: dupe.id, name: `${dupe.first_name || ''} ${dupe.last_name || ''}`.trim() } });
  }
  const id = uuid();
  const sourceId = await getOrCreateSourceId(b.leadSource || 'Manual');
  await pool.query(`
    INSERT INTO leads (id, first_name, last_name, email, phone, mobile, company, job_title, website,
      street, city, state, country, postal_code, lead_source_id, industry, owner_id, status, priority, expected_deal_size)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
  `, [id, b.firstName || null, b.lastName || null, b.email || null, b.phone || null, b.mobile || null,
      b.company || null, b.jobTitle || null, b.website || null, b.street || null, b.city || null,
      b.state || null, b.country || null, b.postalCode || null, sourceId, b.industry || null,
      b.ownerId || null, dupe ? 'duplicate' : (b.status || 'new'), b.priority || 'medium', b.expectedDealSize || null]);
  if (b.notes) await pool.query('INSERT INTO lead_notes (id, lead_id, body) VALUES ($1,$2,$3)', [uuid(), id, b.notes]);
  for (const tagName of (b.tags || [])) {
    let tagRow = (await pool.query('SELECT id FROM tags WHERE name = $1', [tagName])).rows[0];
    const tagId = tagRow ? tagRow.id : (await pool.query('INSERT INTO tags (name) VALUES ($1) RETURNING id', [tagName])).rows[0].id;
    await pool.query('INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, tagId]);
  }
  await logActivity(id, 'Created', dupe ? `Flagged as possible duplicate of ${dupe.id}` : 'Manual entry');
  res.status(201).json({ id });
}));

app.patch('/api/leads/:id', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
  const lead = rows[0];
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const { status, note } = req.body;
  if (status && status !== lead.status) {
    await pool.query('UPDATE leads SET status = $1, updated_at = now() WHERE id = $2', [status, req.params.id]);
    await logActivity(req.params.id, 'Status changed', `${lead.status} -> ${status}`);
  }
  if (note) {
    await pool.query('INSERT INTO lead_notes (id, lead_id, body) VALUES ($1,$2,$3)', [uuid(), req.params.id, note]);
    await logActivity(req.params.id, 'Note added', note);
  }
  res.json({ ok: true });
}));

app.delete('/api/leads/:id', ah(async (req, res) => {
  await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------------- CSV import (rows already parsed client-side) ---------------- */

app.post('/api/imports/rows', ah(async (req, res) => {
  const { fileName, rows, mapping } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

  const jobId = uuid();
  let success = 0, failed = 0, duplicates = 0;
  const errors = [];
  const insertedForDedupeCheck = [];
  const sourceId = await getOrCreateSourceId('CSV');

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const lead = { first_name: '', last_name: '', email: '', phone: '', company: '', job_title: '' };
    for (const [csvCol, internalField] of Object.entries(mapping || {})) {
      if (internalField && internalField !== 'skip' && row[csvCol] !== undefined) {
        const key = { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', company: 'company', jobTitle: 'job_title' }[internalField];
        if (key) lead[key] = (row[csvCol] || '').toString().trim();
      }
    }
    if (!lead.email && !lead.phone) {
      failed++; errors.push({ row: idx + 2, reason: 'Missing both email and phone', raw: JSON.stringify(row) });
      continue;
    }
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
      failed++; errors.push({ row: idx + 2, reason: `Invalid email: ${lead.email}`, raw: JSON.stringify(row) });
      continue;
    }
    const dupe = (await findDuplicate(lead)) || insertedForDedupeCheck.find(l =>
      (lead.email && l.email === lead.email) || (lead.phone && l.phone === lead.phone));
    const status = dupe ? 'duplicate' : 'new';
    if (dupe) duplicates++;
    const id = uuid();
    await pool.query(`
      INSERT INTO leads (id, first_name, last_name, email, phone, company, job_title, lead_source_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [id, lead.first_name, lead.last_name, lead.email, lead.phone, lead.company, lead.job_title, sourceId, status]);
    await logActivity(id, 'Imported', `via CSV/Excel — ${fileName || 'upload'}`);
    insertedForDedupeCheck.push(lead);
    success++;
  }

  await pool.query(`
    INSERT INTO import_jobs (id, source, file_name, status, total_rows, success_count, failed_count, duplicate_count, started_at, completed_at)
    VALUES ($1,'csv',$2,'completed',$3,$4,$5,$6, now(), now())
  `, [jobId, fileName || 'upload', rows.length, success, failed, duplicates]);

  for (const e of errors) {
    await pool.query('INSERT INTO import_errors (id, import_job_id, row_number, reason, raw_row) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), jobId, e.row, e.reason, e.raw]);
  }

  res.json({ jobId, fileName, total: rows.length, success, failed, duplicates, errors });
}));

app.get('/api/imports', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM import_jobs ORDER BY created_at DESC');
  res.json(rows);
}));

app.get('/api/imports/:id/errors', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT row_number, reason FROM import_errors WHERE import_job_id = $1', [req.params.id]);
  const csv = 'Row,Reason\n' + rows.map(r => `${r.row_number},"${(r.reason || '').replace(/"/g, '""')}"`).join('\n');
  res.header('Content-Type', 'text/csv');
  res.attachment(`import-errors-${req.params.id}.csv`);
  res.send(csv);
}));

/* ---------------- CRM integrations (real HubSpot sync, real Postgres writes) ---------------- */

app.get('/api/integrations/status', (req, res) => {
  res.json({
    hubspot: { connected: Boolean(process.env.HUBSPOT_ACCESS_TOKEN), real: true },
    salesforce: { connected: false, real: false },
  });
});

app.post('/api/integrations/:provider/sync', ah(async (req, res) => {
  const providerParam = req.params.provider;

  /* ---- Real HubSpot sync (Private App token) ---- */
  if (providerParam === 'hubspot') {
    const sourceId = await getOrCreateSourceId('HubSpot');
    let contacts;
    try {
      contacts = await fetchHubSpotContacts(20);
    } catch (e) {
      if (e.code === 'NO_TOKEN') {
        return res.status(400).json({ error: 'HubSpot is not connected yet. Add HUBSPOT_ACCESS_TOKEN in your hosting environment variables, then try again.' });
      }
      if (e.status === 401) {
        return res.status(401).json({ error: 'HubSpot rejected the access token. Double check HUBSPOT_ACCESS_TOKEN was copied correctly.' });
      }
      return res.status(502).json({ error: 'Could not reach HubSpot: ' + e.message });
    }

    const jobId = uuid();
    let success = 0, duplicates = 0, skipped = 0;

    for (const c of contacts) {
      const p = c.properties || {};
      if (!p.email && !p.phone) { skipped++; continue; }

      // avoid re-importing the same HubSpot contact on repeat syncs
      const already = await pool.query('SELECT id FROM leads WHERE external_id = $1 AND lead_source_id = $2', [c.id, sourceId]);
      if (already.rows[0]) { skipped++; continue; }

      const lead = { first_name: p.firstname || '', last_name: p.lastname || '', email: p.email || '', phone: p.phone || '', company: p.company || '', job_title: p.jobtitle || '' };
      const dupe = await findDuplicate(lead);
      const status = dupe ? 'duplicate' : 'new';
      if (dupe) duplicates++;
      const id = uuid();
      await pool.query(`
        INSERT INTO leads (id, first_name, last_name, email, phone, company, job_title, lead_source_id, status, external_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [id, lead.first_name, lead.last_name, lead.email, lead.phone, lead.company, lead.job_title, sourceId, status, c.id]);
      await logActivity(id, 'Synced', 'via HubSpot integration (real API)');
      success++;
    }

    await pool.query(`
      INSERT INTO import_jobs (id, source, file_name, status, total_rows, success_count, failed_count, duplicate_count, started_at, completed_at)
      VALUES ($1,'hubspot','HubSpot sync','completed',$2,$3,0,$4, now(), now())
    `, [jobId, contacts.length, success, duplicates]);

    return res.json({ jobId, total: contacts.length, success, failed: 0, duplicates, skipped, real: true });
  }

  /* ---- Salesforce: still simulated until that integration is built ---- */
  const provider = 'Salesforce';
  const sample = [{ first_name: 'Kabir', last_name: 'Malhotra', email: 'kabir.malhotra@finserve.io', company: 'FinServe Corp', job_title: 'CFO', phone: '+91 98765 43210' }];

  const sourceId = await getOrCreateSourceId(provider);
  let success = 0, duplicates = 0;
  const jobId = uuid();

  for (const lead of sample) {
    const dupe = await findDuplicate(lead);
    const status = dupe ? 'duplicate' : 'new';
    if (dupe) duplicates++;
    const id = uuid();
    await pool.query(`
      INSERT INTO leads (id, first_name, last_name, email, phone, company, job_title, lead_source_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [id, lead.first_name, lead.last_name, lead.email, lead.phone, lead.company, lead.job_title, sourceId, status]);
    await logActivity(id, 'Synced', `via ${provider} integration (simulated)`);
    success++;
  }

  await pool.query(`
    INSERT INTO import_jobs (id, source, file_name, status, total_rows, success_count, failed_count, duplicate_count, started_at, completed_at)
    VALUES ($1,$2,$3,'completed',$4,$5,0,$6, now(), now())
  `, [jobId, provider.toLowerCase(), `${provider} sync`, sample.length, success, duplicates]);

  res.json({ jobId, total: sample.length, success, failed: 0, duplicates, real: false });
}));

/* ---------------- frontend + health ---------------- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', ah(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, db: 'postgres' });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server keeps running):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server keeps running):', err);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Lead Manager running at http://localhost:${PORT}`);
  console.log(`API base:            http://localhost:${PORT}/api`);
});
