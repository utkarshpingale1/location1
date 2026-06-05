/**
 * sync_server.js
 * ─────────────────────────────────────────────────────────────────────────
 * A long-running Express server deployed on Render that does TWO things:
 *
 *  1. USERS SYNC  (every 30s)
 *     PostgreSQL users table → MongoDB users collection
 *     Any user added/updated/deleted in PG is reflected in Mongo.
 *
 *  2. FULL DATA DUMP  (every 60s)
 *     MongoDB (users + attendance + location) → PostgreSQL
 *     Keeps Postgres as the complete historical record.
 *
 * Deploy on Render as a Web Service:
 *   Build command : npm install
 *   Start command : node sync_server.js
 *
 * Environment variables (set in Render dashboard):
 *   MONGO_URI    = mongodb+srv://user:pass@cluster/
 *   DATABASE_URL = postgresql://user:pass@host:5432/Indian_Railway
 *   PORT         = 10000   (Render sets this automatically)
 *
 * Health check endpoint:  GET /health
 * Manual trigger:         POST /sync/now
 * Last sync status:       GET /status
 * ─────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

// ── Config ──────────────────────────────────────────────────────────────────
const MONGO_URI    = process.env.MONGO_URI;
const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@192.168.1.156:5432/Indian_Railway';

const USER_SYNC_INTERVAL  = 30  * 1000;   // 30 seconds
const DUMP_SYNC_INTERVAL  = 60  * 1000;   // 60 seconds
const PORT                = process.env.PORT || 10000;

if (!MONGO_URI) {
  console.error('❌  MONGO_URI not set. Add it to your environment variables.');
  process.exit(1);
}

// ── Express (keeps Render happy — it needs an HTTP server) ──────────────────
const app = express();
app.use(express.json());

// ── State tracking ──────────────────────────────────────────────────────────
const state = {
  lastUserSync:  null,
  lastDumpSync:  null,
  userSyncCount: 0,
  dumpSyncCount: 0,
  errors:        [],
  running:       false,
};

function logErr(label, err) {
  const msg = `[${new Date().toISOString()}] ${label}: ${err.message}`;
  console.error('❌ ' + msg);
  state.errors.unshift(msg);
  if (state.errors.length > 20) state.errors.pop();   // keep last 20 errors
}

// ── MongoDB Schemas ─────────────────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password:      { type: String, default: null },
  password_hash: { type: String, default: null },
  role:          { type: String, enum: ['admin', 'employee'], default: 'employee' },
}, { timestamps: true }));

const Attendance = mongoose.model('Attendance', new mongoose.Schema({
  user_id:       mongoose.Schema.Types.ObjectId,
  clock_in:      Date,
  clock_out:     { type: Date, default: null },
  clock_in_lat:  { type: Number, default: null },
  clock_in_lng:  { type: Number, default: null },
  clock_out_lat: { type: Number, default: null },
  clock_out_lng: { type: Number, default: null },
  total_minutes: { type: Number, default: null },
  notes:         { type: String, default: null },
}, { timestamps: true }));

const Location = mongoose.model('Location', new mongoose.Schema({
  user_id:     mongoose.Schema.Types.ObjectId,
  session_id:  { type: mongoose.Schema.Types.ObjectId, default: null },
  lat:         Number,
  lng:         Number,
  accuracy:    { type: Number, default: null },
  speed:       { type: Number, default: null },
  heading:     { type: Number, default: null },
  recorded_at: { type: Date, default: Date.now },
}));

// ── PostgreSQL pool ─────────────────────────────────────────────────────────
const pg = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

// ── Ensure PG tables exist ──────────────────────────────────────────────────
async function ensurePgTables() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      clock_in      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      clock_out     TIMESTAMPTZ             DEFAULT NULL,
      clock_in_lat  DOUBLE PRECISION        DEFAULT NULL,
      clock_in_lng  DOUBLE PRECISION        DEFAULT NULL,
      clock_out_lat DOUBLE PRECISION        DEFAULT NULL,
      clock_out_lng DOUBLE PRECISION        DEFAULT NULL,
      total_minutes INTEGER                 DEFAULT NULL,
      notes         TEXT                    DEFAULT NULL,
      created_at    TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL    DEFAULT NOW()
    );
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS location (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id  INTEGER          DEFAULT NULL REFERENCES attendance(id) ON DELETE SET NULL,
      lat         DOUBLE PRECISION NOT NULL,
      lng         DOUBLE PRECISION NOT NULL,
      accuracy    DOUBLE PRECISION DEFAULT NULL,
      speed       DOUBLE PRECISION DEFAULT NULL,
      heading     DOUBLE PRECISION DEFAULT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_att_user_clock ON attendance(user_id, clock_in DESC);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_loc_user_rec   ON location(user_id, recorded_at DESC);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_loc_sess_rec   ON location(session_id, recorded_at ASC);`);
  console.log('✅ PG tables ready');
}

// ════════════════════════════════════════════════════════════════════════════
//  SYNC 1 — PostgreSQL users → MongoDB
//  Runs every 30 seconds.
//  - Upserts every PG user into Mongo
//  - Deletes Mongo users that no longer exist in PG
// ════════════════════════════════════════════════════════════════════════════
async function syncUsersToMongo() {
  console.log(`\n[${new Date().toISOString()}] 🔄 USER SYNC: PG → Mongo`);

  const { rows: pgUsers } = await pg.query(
    `SELECT id, emp_id, full_name, password, role, department, sub_team FROM users ORDER BY id`
  );
  console.log(`   PG has ${pgUsers.length} user(s)`);

  let inserted = 0, updated = 0, failed = 0;

  for (const u of pgUsers) {
    const email = (u.emp_id || '').toLowerCase().trim();
    if (!email) { failed++; continue; }

    const role = ['admin', 'employee'].includes(u.role) ? u.role : 'employee';

    try {
      await User.findOneAndUpdate(
        { email },
        {
          $set: {
            name:          u.full_name || email,
            email,
            password:      null,
            password_hash: u.password,   // PG password column holds bcrypt hash
            role,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      inserted++;  // upsert — we count all as success
    } catch (e) {
      logErr(`User upsert ${email}`, e);
      failed++;
    }
  }

  // Remove Mongo users not in PG
  const pgEmails = pgUsers.map(u => (u.emp_id || '').toLowerCase().trim()).filter(Boolean);
  const del = await User.deleteMany({ email: { $nin: pgEmails } });
  if (del.deletedCount > 0)
    console.log(`   🗑  Removed ${del.deletedCount} stale Mongo user(s)`);

  state.lastUserSync  = new Date().toISOString();
  state.userSyncCount++;
  console.log(`   ✅ Done — upserted: ${inserted}, failed: ${failed}, removed: ${del.deletedCount}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  SYNC 2 — MongoDB → PostgreSQL (full dump)
//  Runs every 60 seconds.
//  - Users: upsert from Mongo back to PG (bidirectional safety net)
//  - Attendance: insert new sessions not yet in PG
//  - Location: insert new pings not yet in PG
// ════════════════════════════════════════════════════════════════════════════
async function dumpMongoToPg() {
  console.log(`\n[${new Date().toISOString()}] 🔄 DUMP SYNC: Mongo → PG`);

  // ── Users (bidirectional safety net) ──────────────────────────────────
  const mongoUsers = await User.find({}).lean();
  let upserted = 0;
  for (const u of mongoUsers) {
    const emp_id = u.email;
    let pgPassword = u.password_hash || null;
    if (!pgPassword && u.password) pgPassword = await bcrypt.hash(u.password, 10);
    if (!pgPassword) pgPassword = await bcrypt.hash(`LOCKED_${u._id}`, 10);
    const role = ['admin', 'employee'].includes(u.role) ? u.role : 'employee';
    try {
      await pg.query(
        `INSERT INTO users (emp_id, full_name, password, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (emp_id) DO UPDATE
           SET full_name = EXCLUDED.full_name,
               password  = EXCLUDED.password,
               role      = EXCLUDED.role`,
        [emp_id, u.name, pgPassword, role]
      );
      upserted++;
    } catch (e) { logErr(`PG user upsert ${emp_id}`, e); }
  }
  console.log(`   Users → PG upserted: ${upserted}`);

  // Build mongo→pg user ID map
  const { rows: pgUsers } = await pg.query(`SELECT id, emp_id FROM users`);
  const emailToPgId = Object.fromEntries(pgUsers.map(u => [u.emp_id, u.id]));
  const mongoUserToPgId = {};
  for (const u of mongoUsers) {
    const pgId = emailToPgId[u.email];
    if (pgId) mongoUserToPgId[u._id.toString()] = pgId;
  }

  // ── Attendance ─────────────────────────────────────────────────────────
  // Only insert sessions that don't exist yet in PG
  // We use clock_in timestamp + user_id as the uniqueness check
  const mongoSessions = await Attendance.find({}).lean();
  let attInserted = 0, attSkipped = 0;
  const mongoSessionToPgId = {};

  for (const s of mongoSessions) {
    const pgUserId = mongoUserToPgId[s.user_id?.toString()];
    if (!pgUserId) { attSkipped++; continue; }

    // Check if already exists (match by user_id + clock_in)
    const exists = await pg.query(
      `SELECT id FROM attendance WHERE user_id = $1 AND clock_in = $2 LIMIT 1`,
      [pgUserId, s.clock_in]
    );

    if (exists.rows.length > 0) {
      mongoSessionToPgId[s._id.toString()] = exists.rows[0].id;
      attSkipped++;
      continue;
    }

    try {
      const { rows } = await pg.query(
        `INSERT INTO attendance
           (user_id, clock_in, clock_out,
            clock_in_lat, clock_in_lng,
            clock_out_lat, clock_out_lng,
            total_minutes, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          pgUserId,
          s.clock_in,
          s.clock_out     ?? null,
          s.clock_in_lat  ?? null,
          s.clock_in_lng  ?? null,
          s.clock_out_lat ?? null,
          s.clock_out_lng ?? null,
          s.total_minutes ?? null,
          s.notes         ?? null,
          s.createdAt     || s.clock_in,
          s.updatedAt     || s.clock_in,
        ]
      );
      mongoSessionToPgId[s._id.toString()] = rows[0].id;
      attInserted++;
    } catch (e) { logErr(`Attendance insert`, e); attSkipped++; }
  }
  console.log(`   Attendance → PG inserted: ${attInserted}, already existed: ${attSkipped}`);

  // ── Location pings ─────────────────────────────────────────────────────
  // Get the latest recorded_at already in PG to avoid re-inserting old pings
  const { rows: latestPing } = await pg.query(
    `SELECT MAX(recorded_at) AS latest FROM location`
  );
  const since = latestPing[0]?.latest || new Date(0);

  const newPings = await Location.find({ recorded_at: { $gt: since } }).lean();
  console.log(`   Location pings newer than ${since.toISOString?.() ?? since}: ${newPings.length}`);

  const validPings = newPings.filter(p => {
    return mongoUserToPgId[p.user_id?.toString()] && p.lat != null && p.lng != null;
  });

  const CHUNK = 500;
  let locInserted = 0;
  for (let i = 0; i < validPings.length; i += CHUNK) {
    const chunk = validPings.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((p, ri) => {
      const b = ri * 8;
      values.push(
        mongoUserToPgId[p.user_id.toString()],
        mongoSessionToPgId[p.session_id?.toString()] ?? null,
        p.lat, p.lng,
        p.accuracy ?? null,
        p.speed    ?? null,
        p.heading  ?? null,
        p.recorded_at || new Date(),
      );
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
    });
    try {
      await pg.query(
        `INSERT INTO location
           (user_id, session_id, lat, lng, accuracy, speed, heading, recorded_at)
         VALUES ${placeholders.join(',')}`,
        values
      );
      locInserted += chunk.length;
    } catch (e) { logErr('Location batch insert', e); }
  }
  console.log(`   Location → PG inserted: ${locInserted}`);

  state.lastDumpSync  = new Date().toISOString();
  state.dumpSyncCount++;
  console.log(`   ✅ Dump sync done`);
}

// ── Express routes ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ service: 'Sync Server', status: 'running' }));

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/status', (req, res) => res.json({
  running:       state.running,
  lastUserSync:  state.lastUserSync,
  lastDumpSync:  state.lastDumpSync,
  userSyncCount: state.userSyncCount,
  dumpSyncCount: state.dumpSyncCount,
  recentErrors:  state.errors,
}));

// Manually trigger both syncs right now
app.post('/sync/now', async (req, res) => {
  res.json({ message: 'Sync triggered, check /status for results' });
  try { await syncUsersToMongo(); } catch (e) { logErr('Manual user sync', e); }
  try { await dumpMongoToPg();    } catch (e) { logErr('Manual dump sync', e); }
});

// ── Start ───────────────────────────────────────────────────────────────────
async function start() {
  console.log('\n🚀  Starting Sync Server...');

  // Connect MongoDB
  await mongoose.connect(MONGO_URI, { dbName: 'login_user' });
  console.log('✅ MongoDB connected');

  // Connect PG + ensure tables
  await pg.query('SELECT 1');
  console.log('✅ PostgreSQL connected');
  await ensurePgTables();

  // Start HTTP server (Render requires a bound port)
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ HTTP server listening on port ${PORT}`);
    console.log(`   Health : http://localhost:${PORT}/health`);
    console.log(`   Status : http://localhost:${PORT}/status`);
    console.log(`   Manual : POST http://localhost:${PORT}/sync/now`);
  });

  // Run both syncs immediately on startup
  console.log('\n⚡ Running initial sync...');
  try { await syncUsersToMongo(); } catch (e) { logErr('Initial user sync', e); }
  try { await dumpMongoToPg();    } catch (e) { logErr('Initial dump sync', e); }

  state.running = true;

  // Schedule recurring syncs
  setInterval(async () => {
    try { await syncUsersToMongo(); }
    catch (e) { logErr('Scheduled user sync', e); }
  }, USER_SYNC_INTERVAL);

  setInterval(async () => {
    try { await dumpMongoToPg(); }
    catch (e) { logErr('Scheduled dump sync', e); }
  }, DUMP_SYNC_INTERVAL);

  console.log(`\n📅 Scheduled:`);
  console.log(`   PG → Mongo user sync : every ${USER_SYNC_INTERVAL / 1000}s`);
  console.log(`   Mongo → PG dump      : every ${DUMP_SYNC_INTERVAL / 1000}s`);
}

start().catch(err => {
  console.error('❌  Fatal startup error:', err.message);
  process.exit(1);
});
