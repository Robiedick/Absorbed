// routes/admin.js — Admin-only API. Every endpoint requires is_admin === 1.
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { db }   = require('../db/database');
const { writeLog, LEVELS } = require('../db/logger');

const router     = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'absorbed_super_secret_2026';
const ADMIN_USER = 'robiedick';

// ── Admin auth middleware ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user    = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user || !user.is_admin) {
      writeLog({ userId: payload.id, username: payload.username, action: 'ADMIN_BLOCKED', detail: 'Non-admin tried to access admin route', level: LEVELS.WARN });
      return res.status(403).json({ error: 'Admin access required.' });
    }
    req.user = { ...payload, is_admin: user.is_admin };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token.' });
  }
}

function log(req, action, detail, level = LEVELS.ADMIN, meta = null) {
  writeLog({ userId: req.user.id, username: req.user.username, action, detail, level, meta });
}

// ── GET /api/admin/logs ───────────────────────────────────────────────────────
router.get('/logs', adminAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 1000);
  const offset = parseInt(req.query.offset || '0', 10);
  const level  = req.query.level  || null;
  const search = req.query.search || null;

  let sql    = 'SELECT * FROM logs';
  const params = [];
  const where  = [];

  if (level)  { where.push('level = ?');         params.push(level); }
  if (search) { where.push('(detail LIKE ? OR action LIKE ? OR username LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows  = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as n FROM logs').get().n;

  log(req, 'VIEW_LOGS', `Fetched ${rows.length} log entries (offset ${offset})`);
  res.json({ logs: rows, total });
});

// ── DELETE /api/admin/logs ────────────────────────────────────────────────────
router.delete('/logs', adminAuth, (req, res) => {
  log(req, 'CLEAR_LOGS', 'Admin cleared all logs', LEVELS.ADMIN);
  db.prepare('DELETE FROM logs').run();
  res.json({ message: 'All logs cleared.' });
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', adminAuth, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.created_at,
           s.id AS sys_id, s.name AS sys_name, s.star_type, s.star_level,
           s.energy, s.matter, s.credits,
           COUNT(p.id) AS planet_count
    FROM users u
    LEFT JOIN solar_systems s ON s.user_id = u.id
    LEFT JOIN planets p ON p.solar_system_id = s.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();

  log(req, 'VIEW_USERS', `Listed ${users.length} users`);
  res.json({ users });
});

// ── POST /api/admin/reset-self ────────────────────────────────────────────────
// Wipes the admin's own game progress so they can test from scratch.
router.post('/reset-self', adminAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const sys  = db.prepare('SELECT * FROM solar_systems WHERE user_id = ?').get(req.user.id);
  if (!sys) return res.status(404).json({ error: 'No solar system found.' });

  db.prepare('DELETE FROM planets      WHERE solar_system_id = ?').run(sys.id);
  db.prepare('DELETE FROM build_queue  WHERE solar_system_id = ?').run(sys.id);
  db.prepare('DELETE FROM battles WHERE attacker_id = ? OR defender_id = ?').run(req.user.id, req.user.id);
  db.prepare(`
    UPDATE solar_systems
    SET energy = 500, matter = 500, credits = 250,
        star_level = 1, star_type = 'yellow_dwarf', last_tick = unixepoch()
    WHERE id = ?
  `).run(sys.id);

  log(req, 'RESET_SELF', 'Admin reset their own account', LEVELS.ADMIN);
  res.json({ message: 'Your account has been reset for testing.' });
});

// ── POST /api/admin/reset-user ────────────────────────────────────────────────
router.post('/reset-user', adminAuth, (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required.' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const sys = db.prepare('SELECT * FROM solar_systems WHERE user_id = ?').get(user_id);
  if (!sys) return res.status(404).json({ error: 'No solar system for this user.' });

  db.prepare('DELETE FROM planets     WHERE solar_system_id = ?').run(sys.id);
  db.prepare('DELETE FROM build_queue WHERE solar_system_id = ?').run(sys.id);
  db.prepare('DELETE FROM battles WHERE attacker_id = ? OR defender_id = ?').run(user_id, user_id);
  db.prepare(`
    UPDATE solar_systems
    SET energy = 150, matter = 150, credits = 75,
        star_level = 1, star_type = 'yellow_dwarf', last_tick = unixepoch()
    WHERE id = ?
  `).run(sys.id);

  log(req, 'RESET_USER', `Reset user ${target.username} (id:${user_id})`, LEVELS.ADMIN, { target_id: user_id, target_name: target.username });
  res.json({ message: `${target.username} has been reset.` });
});

// ── DELETE /api/admin/user/:id ────────────────────────────────────────────────
router.delete('/user/:id', adminAuth, (req, res) => {
  const target_id = parseInt(req.params.id, 10);
  if (target_id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself.' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(target_id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const sys = db.prepare('SELECT * FROM solar_systems WHERE user_id = ?').get(target_id);
  if (sys) {
    db.prepare('DELETE FROM planets     WHERE solar_system_id = ?').run(sys.id);
    db.prepare('DELETE FROM build_queue WHERE solar_system_id = ?').run(sys.id);
    db.prepare('DELETE FROM solar_systems WHERE id = ?').run(sys.id);
  }
  db.prepare('DELETE FROM battles WHERE attacker_id = ? OR defender_id = ?').run(target_id, target_id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target_id);

  log(req, 'DELETE_USER', `Deleted user ${target.username} (id:${target_id})`, LEVELS.ADMIN, { target_id, target_name: target.username });
  res.json({ message: `${target.username} deleted.` });
});

// ── POST /api/admin/grant-resources ──────────────────────────────────────────
router.post('/grant-resources', adminAuth, (req, res) => {
  const { user_id, energy = 0, matter = 0, credits = 0 } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required.' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const sys = db.prepare('SELECT * FROM solar_systems WHERE user_id = ?').get(user_id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });

  db.prepare(`
    UPDATE solar_systems
    SET energy  = MIN(energy  + ?, 99999),
        matter  = MIN(matter  + ?, 99999),
        credits = MIN(credits + ?, 99999)
    WHERE id = ?
  `).run(energy, matter, credits, sys.id);

  log(req, 'GRANT_RESOURCES',
    `Granted E:${energy} M:${matter} C:${credits} → ${target.username}`,
    LEVELS.ADMIN,
    { target_id: user_id, target_name: target.username, energy, matter, credits }
  );
  res.json({ message: `Resources granted to ${target.username}.` });
});

// ── POST /api/admin/set-resources ─────────────────────────────────────────────
router.post('/set-resources', adminAuth, (req, res) => {
  const { user_id, energy, matter, credits } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required.' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const sys = db.prepare('SELECT * FROM solar_systems WHERE user_id = ?').get(user_id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });

  const updates = [];
  const vals    = [];
  if (energy  != null) { updates.push('energy = ?');  vals.push(Number(energy)); }
  if (matter  != null) { updates.push('matter = ?');  vals.push(Number(matter)); }
  if (credits != null) { updates.push('credits = ?'); vals.push(Number(credits)); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(sys.id);

  db.prepare(`UPDATE solar_systems SET ${updates.join(', ')} WHERE id = ?`).run(...vals);

  log(req, 'SET_RESOURCES',
    `Set resources for ${target.username}: E:${energy} M:${matter} C:${credits}`,
    LEVELS.ADMIN,
    { target_id: user_id, target_name: target.username, energy, matter, credits }
  );
  res.json({ message: `Resources set for ${target.username}.` });
});

// ── POST /api/admin/complete-queue ────────────────────────────────────────────
router.post('/complete-queue', adminAuth, (req, res) => {
  const { user_id } = req.body;
  const target = user_id
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(user_id)
    : db.prepare("SELECT * FROM users WHERE username = ?").get(req.user.username);

  if (!target) return res.status(404).json({ error: 'User not found.' });
  const sys = db.prepare('SELECT * FROM solar_systems WHERE user_id = ?').get(target.id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });

  // Force all queued items to complete now
  db.prepare(`UPDATE build_queue SET complete_at = 0 WHERE solar_system_id = ? AND done = 0`).run(sys.id);

  log(req, 'COMPLETE_QUEUE',
    `Force-completed build queue for ${target.username}`,
    LEVELS.ADMIN,
    { target_id: target.id, target_name: target.username }
  );
  res.json({ message: `Build queue for ${target.username} force-completed.` });
});

// ── POST /api/admin/add-planet ────────────────────────────────────────────────
router.post('/add-planet', adminAuth, (req, res) => {
  const { user_id, type = 'rocky', orbit_index, level = 1 } = req.body;
  if (!user_id || orbit_index == null) return res.status(400).json({ error: 'user_id and orbit_index required.' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const sys = db.prepare('SELECT * FROM solar_systems WHERE user_id = ?').get(user_id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });

  const occupied = db.prepare('SELECT id FROM planets WHERE solar_system_id = ? AND orbit_index = ?').get(sys.id, orbit_index);
  if (occupied) return res.status(409).json({ error: 'Orbit slot occupied.' });

  const name = type.charAt(0).toUpperCase() + type.slice(1) + '-Admin';
  db.prepare(`INSERT INTO planets (solar_system_id, name, type, orbit_index, level) VALUES (?,?,?,?,?)`)
    .run(sys.id, name, type, orbit_index, level);

  log(req, 'ADD_PLANET',
    `Admin added ${type} planet (orbit ${orbit_index}, lv${level}) to ${target.username}`,
    LEVELS.ADMIN,
    { target_id: user_id, target_name: target.username, type, orbit_index, level }
  );
  res.json({ message: `${type} planet added to ${target.username}'s system.` });
});

// ── POST /api/admin/remove-planet ─────────────────────────────────────────────
router.post('/remove-planet', adminAuth, (req, res) => {
  const { planet_id } = req.body;
  if (!planet_id) return res.status(400).json({ error: 'planet_id required.' });

  const planet = db.prepare('SELECT p.*, s.user_id FROM planets p JOIN solar_systems s ON s.id = p.solar_system_id WHERE p.id = ?').get(planet_id);
  if (!planet) return res.status(404).json({ error: 'Planet not found.' });

  db.prepare('DELETE FROM build_queue WHERE planet_id = ?').run(planet_id);
  db.prepare('DELETE FROM planets WHERE id = ?').run(planet_id);

  log(req, 'REMOVE_PLANET',
    `Admin removed planet ${planet.name} (id:${planet_id})`,
    LEVELS.ADMIN,
    { planet_id, planet_name: planet.name, target_id: planet.user_id }
  );
  res.json({ message: `Planet ${planet.name} removed.` });
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get('/stats', adminAuth, (req, res) => {
  const stats = {
    total_users:   db.prepare('SELECT COUNT(*) as n FROM users').get().n,
    total_planets: db.prepare('SELECT COUNT(*) as n FROM planets').get().n,
    total_battles: db.prepare('SELECT COUNT(*) as n FROM battles').get().n,
    total_logs:    db.prepare('SELECT COUNT(*) as n FROM logs').get().n,
    log_levels:    db.prepare(`SELECT level, COUNT(*) as n FROM logs GROUP BY level`).all(),
    recent_actions: db.prepare(`
      SELECT username, action, detail, created_at FROM logs
      ORDER BY created_at DESC LIMIT 10
    `).all(),
  };
  log(req, 'VIEW_STATS', 'Admin viewed server stats');
  res.json(stats);
});

module.exports = router;
