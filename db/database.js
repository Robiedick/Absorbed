// db/database.js — SQLite schema + helper wrappers
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'absorbed.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT    UNIQUE NOT NULL,
  password     TEXT    NOT NULL,
  is_admin     INTEGER DEFAULT 0,
  created_at   INTEGER DEFAULT (unixepoch())
);

-- Add is_admin column to existing DBs that pre-date this migration
-- (will silently fail if column already exists — that is fine)


CREATE TABLE IF NOT EXISTS solar_systems (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER UNIQUE NOT NULL,
  name         TEXT    NOT NULL,
  star_type    TEXT    DEFAULT 'yellow_dwarf',
  star_level   INTEGER DEFAULT 1,
  energy       REAL    DEFAULT 100,
  matter       REAL    DEFAULT 100,
  credits      REAL    DEFAULT 50,
  last_tick    INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS planets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  solar_system_id INTEGER NOT NULL,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  level           INTEGER DEFAULT 1,
  orbit_index     INTEGER NOT NULL,
  created_at      INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (solar_system_id) REFERENCES solar_systems(id)
);

CREATE TABLE IF NOT EXISTS build_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  solar_system_id INTEGER NOT NULL,
  planet_id       INTEGER,
  action          TEXT    NOT NULL,
  payload         TEXT    DEFAULT '{}',
  complete_at     INTEGER NOT NULL,
  done            INTEGER DEFAULT 0,
  FOREIGN KEY (solar_system_id) REFERENCES solar_systems(id)
);

CREATE TABLE IF NOT EXISTS battles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  attacker_id      INTEGER NOT NULL,
  defender_id      INTEGER NOT NULL,
  attacker_power   INTEGER NOT NULL,
  defender_power   INTEGER NOT NULL,
  winner_id        INTEGER,
  energy_stolen    REAL    DEFAULT 0,
  matter_stolen    REAL    DEFAULT 0,
  credits_stolen   REAL    DEFAULT 0,
  created_at       INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (attacker_id) REFERENCES users(id),
  FOREIGN KEY (defender_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT    DEFAULT 'system',
  action     TEXT    NOT NULL,
  detail     TEXT,
  level      TEXT    DEFAULT 'INFO',
  meta       TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
`);

// ── Migrations (idempotent — safe to run on every boot) ───────────────────────
try { db.exec(`ALTER TABLE users   ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch {}
// Planet visual/physics columns (added in v2)
try { db.exec(`ALTER TABLE planets ADD COLUMN model_file      TEXT`); } catch {}
try { db.exec(`ALTER TABLE planets ADD COLUMN self_rotation   REAL DEFAULT 0.003`); } catch {}
try { db.exec(`ALTER TABLE planets ADD COLUMN orbital_speed   REAL DEFAULT 1.0`); } catch {}
try { db.exec(`ALTER TABLE planets ADD COLUMN size_scale      REAL DEFAULT 1.0`); } catch {}
try { db.exec(`ALTER TABLE planets ADD COLUMN moon_count      INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE planets ADD COLUMN moon_data       TEXT DEFAULT '[]'`); } catch {}
try { db.exec(`ALTER TABLE planets ADD COLUMN council_denied_until INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE planets ADD COLUMN council_deny_streak  INTEGER DEFAULT 0`); } catch {}

// ── Admin seeding: promote 'robiedick' ────────────────────────────────────────
db.prepare(`UPDATE users SET is_admin = 1 WHERE username = 'robiedick'`).run();

// ── Planet production config (server-side, tamper-proof) ─────────────────────
const PLANET_PRODUCTION = {
  rocky:    { energy: 0,  matter: 2.5, credits: 0.5 },
  gas:      { energy: 3,  matter: 0.5, credits: 0   },
  ocean:    { energy: 0.5,matter: 1,   credits: 2   },
  ice:      { energy: 1,  matter: 1,   credits: 0   },
  volcanic: { energy: -0.5, matter: 4, credits: 0   },
  crystal:  { energy: 3,  matter: 0,   credits: 2   },
};

// Star base energy per level per minute
const STAR_ENERGY_PER_LEVEL = 3;

// ── Build costs & times ───────────────────────────────────────────────────────
// Economy target:
//   • 1st planet is free (injected on registration)
//   • Full 8-planet system should take ~1 week with normal income
//   • Upgrading L1→5 is "doable" (a day or two per planet)
//   • L6+ is considerably slower (days per upgrade)
const BUILD_CONFIG = {
  new_planet: {
    cost: { matter: 1200, energy: 900, credits: 300 },
    time: 7200,   // 2 hours
  },

  // level = current planet level (upgrading FROM this level)
  // L1→5: quadratic scaling  (×1, ×4, ×9, ×16, ×25)
  // L6+:  cubic cliff  (×75, ×225, ×675 …)
  upgrade_planet: (level) => {
    const scale = level <= 5
      ? level * level
      : 25 * Math.pow(3, level - 5);
    return {
      cost: {
        matter:  Math.round(280 * scale),
        energy:  Math.round(200 * scale),
        credits: Math.round(70  * scale),
      },
      time: Math.round(scale * 1200),  // L1: 20 min, L2: 80 min, L3: 3 h, L4: 5.3 h, L5: 8.3 h, L6: 25 h, L7: 75 h
    };
  },

  // Star upgrades scale quadratically — meaningful but not a daily routine
  upgrade_star: (level) => ({
    cost: {
      matter:  level * level * 1200,
      energy:  level * level * 800,
      credits: level * level * 300,
    },
    time: level * level * 3600,  // L1→2: 1 h, L2→3: 4 h, L3→4: 9 h …
  }),
};

// ── Resource tick (called before any read/write of resources) ─────────────────
function tickResources(solarSystemId) {
  const sys = db.prepare('SELECT * FROM solar_systems WHERE id = ?').get(solarSystemId);
  if (!sys) return null;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = (now - sys.last_tick) / 60; // minutes

  const planets = db.prepare('SELECT * FROM planets WHERE solar_system_id = ?').all(solarSystemId);

  let dEnergy = elapsed * STAR_ENERGY_PER_LEVEL * sys.star_level;
  let dMatter = 0;
  let dCredits = 0;

  for (const p of planets) {
    const prod = PLANET_PRODUCTION[p.type] || {};
    dEnergy  += (prod.energy  || 0) * p.level * elapsed;
    dMatter  += (prod.matter  || 0) * p.level * elapsed;
    dCredits += (prod.credits || 0) * p.level * elapsed;
  }

  const newEnergy  = Math.min(sys.energy  + dEnergy,  99999);
  const newMatter  = Math.min(sys.matter  + dMatter,  99999);
  const newCredits = Math.min(sys.credits + dCredits, 99999);

  db.prepare(`
    UPDATE solar_systems
    SET energy = ?, matter = ?, credits = ?, last_tick = ?
    WHERE id = ?
  `).run(newEnergy, newMatter, newCredits, now, solarSystemId);

  return { ...sys, energy: newEnergy, matter: newMatter, credits: newCredits, last_tick: now };
}

// ── Combat ────────────────────────────────────────────────────────────────────
function calcPower(solarSystemId) {
  const sys = db.prepare('SELECT * FROM solar_systems WHERE id = ?').get(solarSystemId);
  const planets = db.prepare('SELECT * FROM planets WHERE solar_system_id = ?').all(solarSystemId);
  const ATTACK_WEIGHTS  = { rocky: 1.2, volcanic: 2, crystal: 1.5, gas: 0.8, ocean: 0.9, ice: 0.7 };
  const DEFENSE_WEIGHTS = { rocky: 1.5, ice: 2, ocean: 1.2, gas: 0.8, volcanic: 1,   crystal: 1.3 };

  let attack  = sys.star_level * 10;
  let defense = sys.star_level * 15;
  for (const p of planets) {
    attack  += p.level * (ATTACK_WEIGHTS[p.type]  || 1) * 10;
    defense += p.level * (DEFENSE_WEIGHTS[p.type] || 1) * 10;
  }
  return { attack: Math.round(attack), defense: Math.round(defense) };
}

module.exports = { db, tickResources, calcPower, BUILD_CONFIG, PLANET_PRODUCTION };
