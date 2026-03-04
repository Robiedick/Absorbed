// db/logger.js — centralised action logger; writes to the `logs` table
const { db } = require('./database');

const LEVELS = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR', ACTION: 'ACTION', ADMIN: 'ADMIN' };

/**
 * writeLog(opts)
 * @param {number|null}  userId     - user who triggered the event (null = system)
 * @param {string}       username   - display name
 * @param {string}       action     - short machine tag  e.g. 'BUILD_PLANET'
 * @param {string}       detail     - human-readable description
 * @param {string}       level      - INFO / WARN / ERROR / ACTION / ADMIN
 * @param {object}       meta       - optional extra JSON payload
 */
function writeLog({ userId = null, username = 'system', action, detail, level = LEVELS.INFO, meta = null } = {}) {
  try {
    db.prepare(`
      INSERT INTO logs (user_id, username, action, detail, level, meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      userId,
      username,
      action,
      detail,
      level,
      meta ? JSON.stringify(meta) : null
    );
  } catch (e) {
    // Never let logging crash the app
    console.error('[logger] Failed to write log:', e.message);
  }
}

module.exports = { writeLog, LEVELS };
