// routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { faker } = require('@faker-js/faker');
const { db }  = require('../db/database');
const { writeLog, LEVELS } = require('../db/logger');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'absorbed_super_secret_2026';

// ── Register ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 3-20 characters.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken.' });

  const hash = await bcrypt.hash(password, 10);

  const insertUser = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
  const insertSys  = db.prepare(`
    INSERT INTO solar_systems (user_id, name, star_type)
    VALUES (?, ?, ?)
  `);

  const starTypes = ['yellow_dwarf', 'red_dwarf', 'blue_giant'];
  const starType  = starTypes[Math.floor(Math.random() * starTypes.length)];
  const sysName   = faker.science.chemicalElement().name + ' System';

  const user    = insertUser.run(username, hash);
  insertSys.run(user.lastInsertRowid, sysName, starType);

  // Auto-promote robiedick on register
  const isAdmin = username === 'robiedick' ? 1 : 0;
  if (isAdmin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.lastInsertRowid);

  writeLog({ userId: user.lastInsertRowid, username, action: 'REGISTER', detail: `New account created. System: ${sysName} (${starType})`, level: LEVELS.INFO, meta: { star_type: starType, sys_name: sysName } });

  const token = jwt.sign({ id: user.lastInsertRowid, username, is_admin: isAdmin }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username, is_admin: isAdmin, message: 'Welcome to the galaxy, Commander.' });
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    writeLog({ action: 'LOGIN_FAIL', detail: `Login failed — unknown username: ${username}`, level: LEVELS.WARN });
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    writeLog({ userId: user.id, username, action: 'LOGIN_FAIL', detail: `Wrong password for ${username}`, level: LEVELS.WARN });
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  writeLog({ userId: user.id, username, action: 'LOGIN', detail: `${username} logged in`, level: LEVELS.INFO });

  const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin || 0 }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, is_admin: user.is_admin || 0 });
});

module.exports = router;
