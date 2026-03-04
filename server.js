// server.js — Absorbed main server
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Vendor asset routes ───────────────────────────────────────────────────────
app.use('/vendor/pixi',        express.static(path.join(__dirname, 'node_modules/pixi.js/dist')));
app.use('/vendor/matter',      express.static(path.join(__dirname, 'node_modules/matter-js/build')));
app.use('/vendor/gsap',        express.static(path.join(__dirname, 'node_modules/gsap/dist')));
app.use('/vendor/anime',       express.static(path.join(__dirname, 'node_modules/animejs/lib')));
app.use('/vendor/lottie',      express.static(path.join(__dirname, 'node_modules/lottie-web/build/player')));
app.use('/vendor/howler',      express.static(path.join(__dirname, 'node_modules/howler/dist')));
app.use('/vendor/iconify',     express.static(path.join(__dirname, 'node_modules/@iconify/iconify/dist')));
app.use('/vendor/fontawesome', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free')));
app.use('/vendor/noise',       express.static(path.join(__dirname, 'node_modules/simplex-noise/dist')));
app.use('/vendor/three',       express.static(path.join(__dirname, 'node_modules/three')));

// ── API Routes ────────────────────────────────────────────────────────────────
// Request-level logging middleware (logs every API call)
const { writeLog, LEVELS } = require('./db/logger');
app.use('/api', (req, _res, next) => {
  // Skip noisy state polls from logging
  if (req.path === '/game/state' || req.path === '/game/process-queue') return next();
  writeLog({ action: 'HTTP_' + req.method, detail: `${req.method} ${req.path}`, level: LEVELS.INFO, meta: req.body && Object.keys(req.body).length ? { body: req.body } : null });
  next();
});

app.use('/api/auth',  require('./routes/auth'));
app.use('/api/game',  require('./routes/game'));
app.use('/api/admin', require('./routes/admin'));
app.get('/api/status', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const userSockets = new Map();  // username → socket.id

io.on('connection', (socket) => {
  socket.on('register', (username) => {
    userSockets.set(username, socket.id);
    socket.username = username;
    io.emit('galaxy:update', { online: userSockets.size });
  });

  // Forward battle result notification to defender
  socket.on('battle:result', (data) => {
    const targetId = userSockets.get(data.defender_name);
    if (targetId) {
      io.to(targetId).emit('battle:incoming', {
        attacker: data.attacker_name,
        outcome: data.outcome === 'victory' ? 'defeat' : 'victory',
        stolen: data.stolen,
      });
    }
  });

  socket.on('chat:message', (msg) => {
    const safe = String(msg).slice(0, 200).replace(/</g, '&lt;');
    io.emit('chat:message', { from: socket.username || '?', text: safe, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      userSockets.delete(socket.username);
      io.emit('galaxy:update', { online: userSockets.size });
    }
  });
});

// ── SPA catch-all ─────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✖  Port ${PORT} is already in use. Run: lsof -ti :${PORT} | xargs kill -9\n`);
    process.exit(1);
  } else throw err;
});

server.listen(PORT, () => {
  console.log(`\n  ✦  Absorbed running  →  http://localhost:${PORT}\n`);
});
