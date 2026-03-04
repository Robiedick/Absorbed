// routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { faker } = require('@faker-js/faker');
const { db }  = require('../db/database');
const { writeLog, LEVELS } = require('../db/logger');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'absorbed_super_secret_2026';

// Starter planet visual pools (mirrors game.js — used for the free first planet)
const STARTER_ROCKY_MODELS = ['Fossil_Planet.glb','Mars_Red_planet.glb','Rust_Planet.glb','Rusted_Planet.glb','Dark_Metal_Planet.glb','Metallic_Planet.glb','Light_Metal_Planet.glb'];
const STARTER_MOON_POOL    = ['Dark_Metal_Planet.glb','Fossil_Planet.glb','Rust_Planet.glb','Metallic_Planet.glb','Rusted_Planet.glb'];

function rand(min, max) { return min + Math.random() * (max - min); }

function starterPlanetVisuals() {
  const moonCount = Math.random() < 0.5 ? 1 : Math.random() < 0.7 ? 0 : 2;
  const moons = Array.from({ length: moonCount }, () => ({
    model_file:     STARTER_MOON_POOL[Math.floor(Math.random() * STARTER_MOON_POOL.length)],
    orbital_speed:  rand(0.008, 0.035),
    orbital_radius: rand(1.6, 2.8),
    size_scale:     rand(0.08, 0.22),
    tilt:           rand(0, 0.5),
  }));
  return {
    model_file:    STARTER_ROCKY_MODELS[Math.floor(Math.random() * STARTER_ROCKY_MODELS.length)],
    self_rotation: rand(0.001, 0.012),
    orbital_speed: rand(0.5, 2.2),
    size_scale:    rand(0.7, 1.3),
    moon_count:    moonCount,
    moon_data:     JSON.stringify(moons),
  };
}

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

  const user = insertUser.run(username, hash);
  const sys  = insertSys.run(user.lastInsertRowid, sysName, starType);

  // ── Free starter planet (rocky, orbit 0) ─────────────────────────────────
  const vis         = starterPlanetVisuals();
  const planetName  = faker.science.chemicalElement().name;
  db.prepare(`
    INSERT INTO planets
      (solar_system_id, name, type, orbit_index,
       model_file, self_rotation, orbital_speed, size_scale, moon_count, moon_data)
    VALUES (?, ?, 'rocky', 0, ?, ?, ?, ?, ?, ?)
  `).run(sys.lastInsertRowid, planetName,
         vis.model_file, vis.self_rotation, vis.orbital_speed,
         vis.size_scale, vis.moon_count, vis.moon_data);

  // Auto-promote robiedick on register
  const isAdmin = username === 'robiedick' ? 1 : 0;
  if (isAdmin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.lastInsertRowid);

  writeLog({ userId: user.lastInsertRowid, username, action: 'REGISTER', detail: `New account created. System: ${sysName} (${starType}). Free starter planet: ${planetName}`, level: LEVELS.INFO, meta: { star_type: starType, sys_name: sysName, starter_planet: planetName } });

  const token = jwt.sign({ id: user.lastInsertRowid, username, is_admin: isAdmin }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username, is_admin: isAdmin, message: 'Welcome to the galaxy, Commander. Your first planet has been colonised.' });
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
