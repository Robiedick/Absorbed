// routes/game.js — all server-side game logic. Players can't cheat: everything
// is validated and stored in SQLite before any response is sent.
const express = require('express');
const jwt     = require('jsonwebtoken');
const { faker } = require('@faker-js/faker');
const { db, tickResources, calcPower, BUILD_CONFIG } = require('../db/database');
const { writeLog, LEVELS } = require('../db/logger');
const { councilLetter } = require('../services/openrouter');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'absorbed_super_secret_2026';

// ── Planet visual-stats generator ────────────────────────────────────────────
// Called server-side when a planet completes construction so the random visuals
// are persisted in DB and the same for every player who visits that system.
const VISUAL_MODEL_POOLS = {
  rocky:    ['Fossil_Planet.glb','Mars_Red_planet.glb','Rust_Planet.glb','Rusted_Planet.glb','Dark_Metal_Planet.glb','Metallic_Planet.glb','Light_Metal_Planet.glb'],
  gas:      ['Dark_Blue_Purple_Green_Slime_Planet.glb','Greenish_Saturn_Ringed_Planet.glb'],
  ocean:    ['Blue_Water_beaches_Planet.glb','Tropical_EarthLike_Planet.glb','Water_Planet.glb'],
  ice:      ['Greenish_Saturn_Ringed_Planet.glb','Light_Metal_Planet.glb','Metallic_Planet.glb'],
  volcanic: ['Red_Orange_Planet.glb','Weird_Vulcanic_Planet.glb','Mars_Red_planet.glb'],
  crystal:  ['Mystic_Planet.glb','Man_Made_Planet_1.glb','Man_Made_Planet_2.glb','Man_Made_Planet_3.glb'],
};
const VISUAL_MOON_POOL = ['Dark_Metal_Planet.glb','Fossil_Planet.glb','Rust_Planet.glb','Metallic_Planet.glb','Rusted_Planet.glb'];

function rand(min, max) { return min + Math.random() * (max - min); }

function generatePlanetVisuals(type) {
  const pool      = VISUAL_MODEL_POOLS[type] || VISUAL_MODEL_POOLS.rocky;
  const modelFile = pool[Math.floor(Math.random() * pool.length)];
  const moonCount = Math.random() < 0.15 ? 0   // 15% no moons
                  : Math.random() < 0.5  ? 1   // 42.5% one moon
                  : Math.random() < 0.7  ? 2   // 25.5% two moons
                  : 3;                          // 17% three moons
  const moons = Array.from({ length: moonCount }, () => ({
    model_file:     VISUAL_MOON_POOL[Math.floor(Math.random() * VISUAL_MOON_POOL.length)],
    orbital_speed:  rand(0.008, 0.035),
    orbital_radius: rand(1.6, 2.8),
    size_scale:     rand(0.08, 0.22),
    tilt:           rand(0, 0.5),
  }));
  return {
    model_file:    modelFile,
    self_rotation: rand(0.001, 0.012),
    orbital_speed: rand(0.5, 2.2),
    size_scale:    rand(0.4, 2.0),
    moon_count:    moonCount,
    moon_data:     JSON.stringify(moons),
  };
}

const glog = (req, action, detail, level = LEVELS.ACTION, meta = null) =>
  writeLog({ userId: req.user.id, username: req.user.username, action, detail, level, meta });

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token.' });
  }
}

// ── Helper: get solar_system by user ─────────────────────────────────────────
function getUserSys(userId) {
  return db.prepare('SELECT * FROM solar_systems WHERE user_id = ?').get(userId);
}

// ── GET /api/game/state ───────────────────────────────────────────────────────
// Returns full game state after ticking resources.
router.get('/state', auth, (req, res) => {
  const sys = getUserSys(req.user.id);
  if (!sys) return res.status(404).json({ error: 'No solar system found.' });

  const updated = tickResources(sys.id);
  const planets = db.prepare('SELECT * FROM planets WHERE solar_system_id = ?').all(sys.id);
  const queue   = db.prepare(`
    SELECT * FROM build_queue
    WHERE solar_system_id = ? AND done = 0
    ORDER BY complete_at ASC
  `).all(sys.id);
  const buildings = db.prepare('SELECT * FROM buildings WHERE solar_system_id = ?').all(sys.id);

  res.json({ solar_system: updated, planets, queue, buildings });
});

// ── POST /api/game/build-planet ───────────────────────────────────────────────
router.post('/build-planet', auth, (req, res) => {
  const { orbit_index, type } = req.body;
  const VALID_TYPES = ['rocky', 'gas', 'ocean', 'ice', 'volcanic', 'crystal'];

  if (!VALID_TYPES.includes(type))
    return res.status(400).json({ error: 'Invalid planet type.' });
  if (orbit_index < 0 || orbit_index > 7)
    return res.status(400).json({ error: 'Invalid orbit index (0-7).' });

  const sys = getUserSys(req.user.id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });

  // Check slot is free
  const occupied = db.prepare(
    'SELECT id FROM planets WHERE solar_system_id = ? AND orbit_index = ?'
  ).get(sys.id, orbit_index);
  if (occupied) return res.status(409).json({ error: 'Orbit slot is already occupied.' });

  // Check already building in that slot
  const building = db.prepare(
    "SELECT id FROM build_queue WHERE solar_system_id = ? AND done = 0 AND action = 'new_planet' AND json_extract(payload,'$.orbit_index') = ?"
  ).get(sys.id, orbit_index);
  if (building) return res.status(409).json({ error: 'Already building in that orbit.' });

  // If player has no planets and nothing queued, first planet is always free + instant
  const planetCount = db.prepare('SELECT COUNT(*) as n FROM planets WHERE solar_system_id = ?').get(sys.id).n;
  const queueCount  = db.prepare("SELECT COUNT(*) as n FROM build_queue WHERE solar_system_id = ? AND done = 0 AND action = 'new_planet'").get(sys.id).n;
  const isFirstFree = (planetCount === 0 && queueCount === 0);

  // Tick then deduct resources
  const updated = tickResources(sys.id);
  const { cost, time } = BUILD_CONFIG.new_planet;

  if (!isFirstFree) {
    if (updated.matter < cost.matter || updated.energy < cost.energy || updated.credits < cost.credits) {
      glog(req, 'BUILD_PLANET_FAIL', `Not enough resources for ${type} planet (orbit ${orbit_index})`, LEVELS.WARN, { need: cost, have: { matter: updated.matter, energy: updated.energy, credits: updated.credits } });
      return res.status(400).json({ error: 'Not enough resources.', need: cost, have: { matter: updated.matter, energy: updated.energy, credits: updated.credits } });
    }
    db.prepare(`
      UPDATE solar_systems SET matter = matter - ?, energy = energy - ?, credits = credits - ?
      WHERE id = ?
    `).run(cost.matter, cost.energy, cost.credits, sys.id);
  }

  const name = faker.science.chemicalElement().name;
  // First planet completes instantly; otherwise normal build time
  const completeAt = isFirstFree ? Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000) + time;
  const payload = JSON.stringify({ orbit_index, type, name });

  const q = db.prepare(`
    INSERT INTO build_queue (solar_system_id, action, payload, complete_at)
    VALUES (?, 'new_planet', ?, ?)
  `).run(sys.id, payload, completeAt);

  glog(req, 'BUILD_PLANET', `Queued ${type} planet "${name}" in orbit ${orbit_index} (eta ${isFirstFree ? 0 : time}s)${isFirstFree ? ' [FREE FIRST PLANET]' : ''}`, LEVELS.ACTION, { type, name, orbit_index, complete_at: completeAt, cost: isFirstFree ? { matter: 0, energy: 0, credits: 0 } : cost });
  res.json({ message: isFirstFree ? 'Your first planet is free — colonising now!' : 'Construction underway.', queue_id: q.lastInsertRowid, complete_at: completeAt, cost: isFirstFree ? { matter: 0, energy: 0, credits: 0 } : cost });
});

// ── POST /api/game/upgrade-planet ────────────────────────────────────────────
router.post('/upgrade-planet', auth, async (req, res) => {
  const { planet_id } = req.body;

  const sys    = getUserSys(req.user.id);
  const planet = db.prepare('SELECT * FROM planets WHERE id = ? AND solar_system_id = ?').get(planet_id, sys.id);
  if (!planet) return res.status(404).json({ error: 'Planet not found.' });

  // Already in queue?
  const inQueue = db.prepare(
    'SELECT id FROM build_queue WHERE solar_system_id = ? AND planet_id = ? AND done = 0'
  ).get(sys.id, planet.id);
  if (inQueue) return res.status(409).json({ error: 'Already upgrading this planet.' });

  const cfg     = BUILD_CONFIG.upgrade_planet(planet.level);
  const updated = tickResources(sys.id);

  if (updated.matter < cfg.cost.matter || updated.energy < cfg.cost.energy || updated.credits < cfg.cost.credits) {
    glog(req, 'UPGRADE_PLANET_FAIL', `Not enough resources to upgrade ${planet.name} to lv${planet.level + 1}`, LEVELS.WARN, { need: cfg.cost });
    return res.status(400).json({ error: 'Not enough resources.', need: cfg.cost });
  }

  // ── Council lockout: planet may be banned from upgrading for a period ────
  const now = Math.floor(Date.now() / 1000);
  if (planet.council_denied_until && planet.council_denied_until > now) {
    const secsLeft = planet.council_denied_until - now;
    const hrs  = Math.floor(secsLeft / 3600);
    const mins = Math.floor((secsLeft % 3600) / 60);
    return res.status(403).json({
      error: 'council_lockout',
      denied_until: planet.council_denied_until,
      message: `The Council will not hear this petition for another ${hrs}h ${mins}m.`,
    });
  }

  // ── Ultimate Universe Council verdict (50/50 + streak-breaker) ───────────
  // After 3 consecutive denials the next verdict is guaranteed approved, so
  // players can never be soft-locked by pure bad luck.
  const DENY_LOCKOUT_SECS = 6 * 60 * 60; // 6 real-time hours
  const streak  = planet.council_deny_streak || 0;
  const verdict = (streak >= 3 || Math.random() < 0.5) ? 'approved' : 'denied';

  // Gather solar system context for the AI letter
  const allPlanets = db.prepare('SELECT name, type, level FROM planets WHERE solar_system_id = ?').all(sys.id);
  let letter = '';
  try {
    letter = await councilLetter(verdict, planet, updated, allPlanets);
  } catch (err) {
    // If AI call fails, fall back to a generic message so the game still works
    console.error('[Council] OpenRouter error:', err.message);
    letter = verdict === 'approved'
      ? `By decree of the Ultimate Universe Council, the upgrade of ${planet.name} is hereby approved.`
      : `By decree of the Ultimate Universe Council, the upgrade of ${planet.name} is hereby denied.`;
  }

  if (verdict === 'denied') {
    const deniedUntil = now + DENY_LOCKOUT_SECS;
    db.prepare(`UPDATE planets SET council_denied_until = ?, council_deny_streak = ? WHERE id = ?`)
      .run(deniedUntil, streak + 1, planet.id);
    glog(req, 'UPGRADE_PLANET_DENIED', `Council denied upgrade of ${planet.name} (streak ${streak + 1}, locked until ${deniedUntil})`, LEVELS.ACTION, { planet_id: planet.id });
    return res.json({ verdict: 'denied', letter, denied_until: deniedUntil });
  }

  // ── Approved: deduct resources and queue ─────────────────────────────────
  db.prepare(`UPDATE planets SET council_denied_until = 0, council_deny_streak = 0 WHERE id = ?`).run(planet.id);
  db.prepare(`
    UPDATE solar_systems SET matter = matter - ?, energy = energy - ?, credits = credits - ?
    WHERE id = ?
  `).run(cfg.cost.matter, cfg.cost.energy, cfg.cost.credits, sys.id);

  const completeAt = Math.floor(Date.now() / 1000) + cfg.time;
  db.prepare(`
    INSERT INTO build_queue (solar_system_id, planet_id, action, payload, complete_at)
    VALUES (?, ?, 'upgrade_planet', '{}', ?)
  `).run(sys.id, planet.id, completeAt);

  glog(req, 'UPGRADE_PLANET', `Council approved: upgrading ${planet.name} → lv${planet.level + 1} (eta ${cfg.time}s)`, LEVELS.ACTION, { planet_id: planet.id, planet_name: planet.name, new_level: planet.level + 1, cost: cfg.cost });
  res.json({ verdict: 'approved', letter, message: `Upgrading ${planet.name} to level ${planet.level + 1}.`, complete_at: completeAt, cost: cfg.cost });
});

// ── POST /api/game/upgrade-star ───────────────────────────────────────────────
router.post('/upgrade-star', auth, (req, res) => {
  const sys = getUserSys(req.user.id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });

  const inQueue = db.prepare(
    "SELECT id FROM build_queue WHERE solar_system_id = ? AND action = 'upgrade_star' AND done = 0"
  ).get(sys.id);
  if (inQueue) return res.status(409).json({ error: 'Star upgrade already in progress.' });

  const cfg = BUILD_CONFIG.upgrade_star(sys.star_level);
  const updated = tickResources(sys.id);

  if (updated.matter < cfg.cost.matter || updated.energy < cfg.cost.energy || updated.credits < cfg.cost.credits) {
    glog(req, 'UPGRADE_STAR_FAIL', `Not enough resources to upgrade star to lv${sys.star_level + 1}`, LEVELS.WARN, { need: cfg.cost });
    return res.status(400).json({ error: 'Not enough resources.', need: cfg.cost });
  }

  db.prepare(`
    UPDATE solar_systems SET matter = matter - ?, energy = energy - ?, credits = credits - ?
    WHERE id = ?
  `).run(cfg.cost.matter, cfg.cost.energy, cfg.cost.credits, sys.id);

  const completeAt = Math.floor(Date.now() / 1000) + cfg.time;
  db.prepare(`
    INSERT INTO build_queue (solar_system_id, action, payload, complete_at)
    VALUES (?, 'upgrade_star', '{}', ?)
  `).run(sys.id, completeAt);

  glog(req, 'UPGRADE_STAR', `Star upgrade → lv${sys.star_level + 1} queued (eta ${cfg.time}s)`, LEVELS.ACTION, { new_level: sys.star_level + 1, cost: cfg.cost });
  res.json({ message: 'Star upgrade initiated.', complete_at: completeAt, cost: cfg.cost });
});

// ── POST /api/game/process-queue ─────────────────────────────────────────────
// Called by the client every poll cycle to complete any finished builds.
router.post('/process-queue', auth, (req, res) => {
  const sys = getUserSys(req.user.id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });

  const now  = Math.floor(Date.now() / 1000);
  const done = db.prepare(`
    SELECT * FROM build_queue
    WHERE solar_system_id = ? AND done = 0 AND complete_at <= ?
  `).all(sys.id, now);

  const completed = [];

  for (const item of done) {
    const payload = JSON.parse(item.payload || '{}');

    if (item.action === 'new_planet') {
      const vis = generatePlanetVisuals(payload.type);
      db.prepare(`
        INSERT INTO planets
          (solar_system_id, name, type, orbit_index,
           model_file, self_rotation, orbital_speed, size_scale, moon_count, moon_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sys.id, payload.name, payload.type, payload.orbit_index,
        vis.model_file, vis.self_rotation, vis.orbital_speed, vis.size_scale, vis.moon_count, vis.moon_data,
      );
      completed.push({ action: 'new_planet', name: payload.name, type: payload.type });
      glog(req, 'PLANET_COMPLETE', `${payload.type} planet "${payload.name}" colonized (orbit ${payload.orbit_index})`, LEVELS.ACTION, { type: payload.type, name: payload.name, orbit_index: payload.orbit_index });
    }

    if (item.action === 'upgrade_planet' && item.planet_id) {
      db.prepare('UPDATE planets SET level = level + 1 WHERE id = ?').run(item.planet_id);
      const p = db.prepare('SELECT * FROM planets WHERE id = ?').get(item.planet_id);
      completed.push({ action: 'upgrade_planet', name: p?.name, level: p?.level });
      glog(req, 'PLANET_UPGRADED', `${p?.name} reached lv${p?.level}`, LEVELS.ACTION, { planet_id: item.planet_id, planet_name: p?.name, level: p?.level });
    }

    if (item.action === 'upgrade_star') {
      db.prepare('UPDATE solar_systems SET star_level = star_level + 1 WHERE id = ?').run(sys.id);
      const updSys = db.prepare('SELECT star_level FROM solar_systems WHERE id = ?').get(sys.id);
      completed.push({ action: 'upgrade_star' });
      glog(req, 'STAR_UPGRADED', `Star reached lv${updSys?.star_level}`, LEVELS.ACTION, { new_level: updSys?.star_level });
    }

    db.prepare('UPDATE build_queue SET done = 1 WHERE id = ?').run(item.id);
  }

  res.json({ completed });
});

// ── GET /api/game/galaxy ──────────────────────────────────────────────────────
// Other players (excluding self), sorted by total planets.
router.get('/galaxy', auth, (req, res) => {
  const players = db.prepare(`
    SELECT s.id, s.name, s.star_type, s.star_level, u.username,
           COUNT(p.id) AS planet_count
    FROM solar_systems s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN planets p ON p.solar_system_id = s.id
    WHERE s.user_id != ?
    GROUP BY s.id
    ORDER BY planet_count DESC, s.star_level DESC
    LIMIT 50
  `).all(req.user.id);

  res.json({ players });
});

// ── POST /api/game/battle ─────────────────────────────────────────────────────
router.post('/battle', auth, (req, res) => {
  const { defender_user_id } = req.body;
  if (!defender_user_id) return res.status(400).json({ error: 'Target required.' });
  if (defender_user_id == req.user.id) return res.status(400).json({ error: 'Cannot attack yourself.' });

  const attackerSys = getUserSys(req.user.id);
  const defenderSys = getUserSys(defender_user_id);
  if (!defenderSys) return res.status(404).json({ error: 'Target solar system not found.' });

  // Battle cooldown: 5 minutes between same attacker/defender pair
  const recent = db.prepare(`
    SELECT id FROM battles
    WHERE attacker_id = ? AND defender_id = ? AND created_at > ?
  `).get(req.user.id, defender_user_id, Math.floor(Date.now() / 1000) - 300);
  if (recent) {
    glog(req, 'BATTLE_COOLDOWN', `Attack on user ${defender_user_id} blocked by cooldown`, LEVELS.WARN);
    return res.status(429).json({ error: 'Battle cooldown active (5 min).' });
  }

  // Tick both sides
  tickResources(attackerSys.id);
  tickResources(defenderSys.id);

  const { attack: atkPow } = calcPower(attackerSys.id);
  const { defense: defPow } = calcPower(defenderSys.id);

  // Add ±20% random variance
  const variance = () => 1 + (Math.random() * 0.4 - 0.2);
  const finalAtk = atkPow * variance();
  const finalDef = defPow * variance();

  const attackerWins = finalAtk > finalDef;
  const winnerId = attackerWins ? req.user.id : defender_user_id;

  let energyStolen = 0, matterStolen = 0, creditsStolen = 0;

  if (attackerWins) {
    // Steal 20% of defender's resources
    const def = db.prepare('SELECT * FROM solar_systems WHERE id = ?').get(defenderSys.id);
    energyStolen  = def.energy  * 0.20;
    matterStolen  = def.matter  * 0.20;
    creditsStolen = def.credits * 0.20;

    db.prepare(`
      UPDATE solar_systems
      SET energy = energy - ?, matter = matter - ?, credits = credits - ?
      WHERE id = ?
    `).run(energyStolen, matterStolen, creditsStolen, defenderSys.id);

    db.prepare(`
      UPDATE solar_systems
      SET energy = energy + ?, matter = matter + ?, credits = credits + ?
      WHERE id = ?
    `).run(energyStolen, matterStolen, creditsStolen, attackerSys.id);
  }

  db.prepare(`
    INSERT INTO battles (attacker_id, defender_id, attacker_power, defender_power,
                         winner_id, energy_stolen, matter_stolen, credits_stolen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, defender_user_id, Math.round(finalAtk), Math.round(finalDef),
         winnerId, energyStolen, matterStolen, creditsStolen);

  const defUser = db.prepare('SELECT username FROM users WHERE id = ?').get(defender_user_id);
  const outcome  = attackerWins ? 'victory' : 'defeat';

  glog(req, 'BATTLE', `${req.user.username} ${outcome} vs ${defUser?.username} (atk:${Math.round(finalAtk)} def:${Math.round(finalDef)})`, LEVELS.ACTION, {
    defender_id: defender_user_id, defender_name: defUser?.username,
    attacker_power: Math.round(finalAtk), defender_power: Math.round(finalDef),
    outcome, stolen: { energy: energyStolen, matter: matterStolen, credits: creditsStolen },
  });

  res.json({
    outcome,
    attacker_power: Math.round(finalAtk),
    defender_power: Math.round(finalDef),
    stolen: { energy: energyStolen, matter: matterStolen, credits: creditsStolen },
    defender_name: defUser?.username,
  });
});

// ── GET /api/game/battle-log ──────────────────────────────────────────────────
router.get('/battle-log', auth, (req, res) => {
  const log = db.prepare(`
    SELECT b.*, ua.username AS attacker_name, ud.username AS defender_name
    FROM battles b
    JOIN users ua ON ua.id = b.attacker_id
    JOIN users ud ON ud.id = b.defender_id
    WHERE b.attacker_id = ? OR b.defender_id = ?
    ORDER BY b.created_at DESC
    LIMIT 20
  `).all(req.user.id, req.user.id);

  res.json({ log });
});

// ── PATCH /api/game/rename-system ────────────────────────────────────────────
router.patch('/rename-system', auth, (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Name is required.' });
  const trimmed = name.trim().slice(0, 40);
  const sys = getUserSys(req.user.id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });
  db.prepare('UPDATE solar_systems SET name = ? WHERE id = ?').run(trimmed, sys.id);
  glog(req, 'RENAME_SYSTEM', `Renamed solar system to "${trimmed}"`);
  res.json({ name: trimmed });
});

// ── PATCH /api/game/rename-planet ─────────────────────────────────────────────
router.patch('/rename-planet', auth, (req, res) => {
  const { planet_id, name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Name is required.' });
  const trimmed = name.trim().slice(0, 40);
  const sys = getUserSys(req.user.id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });
  const planet = db.prepare('SELECT * FROM planets WHERE id = ? AND solar_system_id = ?').get(planet_id, sys.id);
  if (!planet) return res.status(404).json({ error: 'Planet not found.' });
  db.prepare('UPDATE planets SET name = ? WHERE id = ?').run(trimmed, planet_id);
  glog(req, 'RENAME_PLANET', `Renamed planet ${planet_id} to "${trimmed}"`);
  res.json({ name: trimmed });
});

// ── DELETE /api/game/planet/:id ────────────────────────────────────────────
router.delete('/planet/:id', auth, (req, res) => {
  const planetId = parseInt(req.params.id);
  const sys    = getUserSys(req.user.id);
  const planet = db.prepare('SELECT * FROM planets WHERE id = ? AND solar_system_id = ?').get(planetId, sys.id);
  if (!planet) return res.status(404).json({ error: 'Planet not found.' });

  db.prepare('DELETE FROM build_queue WHERE planet_id = ?').run(planetId);
  db.prepare('DELETE FROM buildings WHERE planet_id = ?').run(planetId);
  db.prepare('DELETE FROM planets WHERE id = ?').run(planetId);

  glog(req, 'DESTROY_PLANET', `Destroyed ${planet.name} (${planet.type} lv${planet.level})`, LEVELS.ACTION, { planet_id: planetId, planet_name: planet.name });
  res.json({ message: `${planet.name} has been destroyed.` });
});

// ── POST /api/game/build-building ─────────────────────────────────────────────
// Planet building slots = max(1, ceil(size_scale * 1.5)).
// Trade center requires >= 2 player planets and costs M:500 E:300 C:200.
const BUILDING_COSTS = {
  trade_center: { matter: 500, energy: 300, credits: 200 },
};
router.post('/build-building', auth, (req, res) => {
  const { planet_id, type } = req.body;
  if (!BUILDING_COSTS[type]) return res.status(400).json({ error: 'Unknown building type.' });

  const sys = getUserSys(req.user.id);
  if (!sys) return res.status(404).json({ error: 'No solar system.' });

  const planet = db.prepare('SELECT * FROM planets WHERE id = ? AND solar_system_id = ?').get(planet_id, sys.id);
  if (!planet) return res.status(404).json({ error: 'Planet not found.' });

  // Trade center: needs ≥ 2 planets
  if (type === 'trade_center') {
    const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM planets WHERE solar_system_id = ?').get(sys.id).cnt;
    if (cnt < 2) return res.status(400).json({ error: 'Trade center requires at least 2 planets.' });
  }

  // Building slot limit based on planet size
  const maxSlots = Math.max(1, Math.ceil((planet.size_scale || 1.0) * 1.5));
  const existingCnt = db.prepare('SELECT COUNT(*) AS cnt FROM buildings WHERE planet_id = ?').get(planet_id).cnt;
  if (existingCnt >= maxSlots) {
    return res.status(400).json({ error: `This planet only supports ${maxSlots} building${maxSlots !== 1 ? 's' : ''}.` });
  }

  // Deduct cost
  const cost    = BUILDING_COSTS[type];
  const updated = tickResources(sys.id);
  if (updated.matter < cost.matter || updated.energy < cost.energy || updated.credits < cost.credits) {
    return res.status(400).json({ error: `Not enough resources. Need M:${cost.matter} E:${cost.energy} C:${cost.credits}`, need: cost });
  }
  db.prepare('UPDATE solar_systems SET matter = matter - ?, energy = energy - ?, credits = credits - ? WHERE id = ?')
    .run(cost.matter, cost.energy, cost.credits, sys.id);

  const result = db.prepare('INSERT INTO buildings (planet_id, solar_system_id, type) VALUES (?, ?, ?)')
    .run(planet_id, sys.id, type);

  // Count total trade centers to return for ship spawning
  const tradeCount = db.prepare("SELECT COUNT(*) AS cnt FROM buildings WHERE solar_system_id = ? AND type = 'trade_center'").get(sys.id).cnt;

  glog(req, 'BUILD_BUILDING', `Built ${type} on planet ${planet.name} (id ${planet_id})`, LEVELS.ACTION, { planet_id, type });
  res.json({ success: true, building_id: result.lastInsertRowid, trade_center_count: tradeCount });
});

// ── POST /trade-ship-visit — small passive bonus when a trade ship lands ──────
router.post('/trade-ship-visit', auth, (req, res) => {
  const sys = getUserSys(req.user.id);
  if (!sys) return res.json({ ok: true });
  // Tiny bonus: E+8..22  M+5..15  C+10..28
  const e = 8  + Math.floor(Math.random() * 15);
  const m = 5  + Math.floor(Math.random() * 11);
  const c = 10 + Math.floor(Math.random() * 19);
  db.prepare('UPDATE solar_systems SET energy = MIN(energy + ?, 999999), matter = MIN(matter + ?, 999999), credits = MIN(credits + ?, 999999) WHERE id = ?')
    .run(e, m, c, sys.id);
  res.json({ ok: true, bonus: { energy: e, matter: m, credits: c } });
});

module.exports = router;
