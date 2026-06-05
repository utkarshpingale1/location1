const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ─── MongoDB Connection ────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, { dbName: 'attendance_db' })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ─── Schemas & Models ──────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password_hash: { type: String, required: true },
  role:          { type: String, enum: ['admin', 'employee'], default: 'employee' },
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  user_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clock_in:      { type: Date, required: true },
  clock_out:     { type: Date, default: null },
  clock_in_lat:  { type: Number, default: null },
  clock_in_lng:  { type: Number, default: null },
  clock_out_lat: { type: Number, default: null },
  clock_out_lng: { type: Number, default: null },
  total_minutes: { type: Number, default: null },
  notes:         { type: String, default: null },
}, { timestamps: true });

const locationSchema = new mongoose.Schema({
  user_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  session_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', default: null },
  lat:         { type: Number, required: true },
  lng:         { type: Number, required: true },
  accuracy:    { type: Number, default: null },
  recorded_at: { type: Date, default: Date.now },
});

attendanceSchema.index({ user_id: 1, clock_in: -1 });
locationSchema.index({ user_id: 1, recorded_at: -1 });

const User       = mongoose.model('User',       userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Location   = mongoose.model('Location',   locationSchema);

// ─── Seed default admin (once on startup) ─────────────────────────────────
async function seedAdmin() {
  const exists = await User.findOne({ email: 'admin@company.com' });
  if (!exists) {
    const hash = await bcrypt.hash('Admin@1234', 10);
    await User.create({ name: 'Admin', email: 'admin@company.com', password_hash: hash, role: 'admin' });
    console.log('🌱 Default admin → admin@company.com / Admin@1234');
  }
}
mongoose.connection.once('open', seedAdmin);

// ─── Auth Middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'supersecret');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function admin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role = 'employee' } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Missing fields' });

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password_hash: hash, role });
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user._id.toString(), name: user.name, role: user.role },
      process.env.JWT_SECRET || 'supersecret',
      { expiresIn: '12h' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clock In
app.post('/api/attendance/clock-in', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const open = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
    if (open) return res.status(400).json({ error: 'Already clocked in' });

    const session = await Attendance.create({
      user_id: req.user.id,
      clock_in: new Date(),
      clock_in_lat: lat,
      clock_in_lng: lng,
    });
    res.json({ session_id: session._id, clocked_in: session.clock_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clock Out
app.post('/api/attendance/clock-out', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const session = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
    if (!session) return res.status(400).json({ error: 'Not clocked in' });

    const now = new Date();
    session.clock_out     = now;
    session.clock_out_lat = lat;
    session.clock_out_lng = lng;
    session.total_minutes = Math.round((now - session.clock_in) / 60000);
    await session.save();

    res.json({ session });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save GPS ping
app.post('/api/location', auth, async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;
    const session = await Attendance.findOne({ user_id: req.user.id, clock_out: null });
    await Location.create({
      user_id:    req.user.id,
      session_id: session?._id || null,
      lat, lng, accuracy,
    });
    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// My attendance history
app.get('/api/attendance/me', auth, async (req, res) => {
  try {
    const rows = await Attendance.find({ user_id: req.user.id })
      .sort({ clock_in: -1 }).limit(30).lean();
    const user = await User.findById(req.user.id).lean();
    res.json(rows.map(r => ({ ...r, name: user?.name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// Live locations (latest ping per user)
app.get('/api/admin/live-locations', auth, admin, async (req, res) => {
  try {
    const locs = await Location.aggregate([
      { $sort: { recorded_at: -1 } },
      { $group: {
          _id:         '$user_id',
          lat:         { $first: '$lat' },
          lng:         { $first: '$lng' },
          accuracy:    { $first: '$accuracy' },
          recorded_at: { $first: '$recorded_at' },
          session_id:  { $first: '$session_id' },
      }},
    ]);

    const userIds = locs.map(l => l._id);
    const users   = await User.find({ _id: { $in: userIds } }).lean();
    const uMap    = Object.fromEntries(users.map(u => [u._id.toString(), u.name]));

    const sessionIds = locs.filter(l => l.session_id).map(l => l.session_id);
    const sessions   = await Attendance.find({ _id: { $in: sessionIds } }).lean();
    const sMap       = Object.fromEntries(sessions.map(s => [s._id.toString(), s]));

    res.json(locs.map(l => ({
      user_id:     l._id,
      name:        uMap[l._id.toString()] || 'Unknown',
      lat:         l.lat,
      lng:         l.lng,
      accuracy:    l.accuracy,
      recorded_at: l.recorded_at,
      session_id:  l.session_id,
      clock_in:    l.session_id ? sMap[l.session_id.toString()]?.clock_in : null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All attendance (with date & user filters)
app.get('/api/admin/attendance', auth, admin, async (req, res) => {
  try {
    const { date, user_id } = req.query;
    const filter = {};
    if (user_id) filter.user_id = user_id;
    if (date) {
      const start = new Date(date);
      const end   = new Date(date); end.setDate(end.getDate() + 1);
      filter.clock_in = { $gte: start, $lt: end };
    }

    const rows  = await Attendance.find(filter).sort({ clock_in: -1 }).limit(200).lean();
    const uids  = [...new Set(rows.map(r => r.user_id.toString()))];
    const users = await User.find({ _id: { $in: uids } }).lean();
    const uMap  = Object.fromEntries(users.map(u => [u._id.toString(), u]));

    res.json(rows.map(r => ({
      ...r,
      name:  uMap[r.user_id.toString()]?.name,
      email: uMap[r.user_id.toString()]?.email,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All users (no passwords)
app.get('/api/admin/users', auth, admin, async (req, res) => {
  try {
    const users = await User.find({}, '-password_hash').sort({ name: 1 }).lean();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Location trail for a session
app.get('/api/admin/location-trail/:session_id', auth, admin, async (req, res) => {
  try {
    const trail = await Location.find({ session_id: req.params.session_id })
      .sort({ recorded_at: 1 }).lean();
    res.json(trail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));