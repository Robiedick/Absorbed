// public/js/app.js — Main application entry point
import { api }                 from './game/api.js';
import { SolarSystemRenderer } from './game/renderer.js';
import { AudioManager }        from './game/audio.js';
import { planet3d }            from './game/planet3d.js';

// ── Globals ───────────────────────────────────────────────────────────────────
const audio    = new AudioManager();
const renderer = new SolarSystemRenderer(
  document.getElementById('canvas-container'),
  onPlanetClick,
  onOrbitClick,
);

let gameState    = null;   // { solar_system, planets, queue }
let selectedPlanet = null;
let currentUser  = null;
let currentUserId = null;  // numeric user id (decoded from JWT)
let isAdmin      = false;
let socket       = null;
let pendingBuildType = null;  // planet type waiting for orbit selection
let pollTimer    = null;
let adminLogPage = 0;
let adminRefreshTimer = null;

const POLL_MS = 5000;  // state refresh rate

// ── Planet config ─────────────────────────────────────────────────────────────
const PLANET_TYPES = {
  rocky:    { icon: '🪨', color: '#8B7355', desc: 'High matter output' },
  gas:      { icon: '🌀', color: '#E8A87C', desc: 'High energy output' },
  ocean:    { icon: '🌊', color: '#1E90FF', desc: 'High credits output' },
  ice:      { icon: '❄️', color: '#ADD8E6', desc: 'Balanced production' },
  volcanic: { icon: '🌋', color: '#CC3300', desc: 'Max matter, top attack' },
  crystal:  { icon: '💎', color: '#9370DB', desc: 'Energy + credits' },
};
const PROD = {
  rocky:    { energy: 0,    matter: 2.5,  credits: 0.5  },
  gas:      { energy: 3,    matter: 0.5,  credits: 0    },
  ocean:    { energy: 0.5,  matter: 1,    credits: 2    },
  ice:      { energy: 1,    matter: 1,    credits: 0    },
  volcanic: { energy: -0.5, matter: 4,    credits: 0    },
  crystal:  { energy: 3,    matter: 0,    credits: 2    },
};

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await renderer.init();
  buildPlanetTypePicker();
  wireAuthUI();
  wireGameUI();

  const token    = localStorage.getItem('absorbed_token');
  const username = localStorage.getItem('absorbed_user');
  isAdmin = localStorage.getItem('absorbed_is_admin') === '1';
  // Always re-derive isAdmin from the JWT payload so stale localStorage can't hide the panel
  if (token) {
    try {
      const pl = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (pl.is_admin) { isAdmin = true; localStorage.setItem('absorbed_is_admin', '1'); }
      if (pl.id) currentUserId = pl.id;
    } catch {}
  }
  if (token && username) {
    api.setToken(token);
    currentUser = username;
    try {
      await loadAndRender();
      showGame();
    } catch {
      localStorage.clear();
      showAuth();
    }
  } else {
    showAuth();
  }
})();

// ── Auth UI ───────────────────────────────────────────────────────────────────
function wireAuthUI() {
  const form      = document.getElementById('auth-form');
  const tabLogin  = document.getElementById('tab-login');
  const tabReg    = document.getElementById('tab-register');
  const errEl     = document.getElementById('auth-error');
  const btnLabel  = document.getElementById('auth-btn-label');
  let mode = 'login';

  tabLogin.addEventListener('click', () => {
    mode = 'login'; tabLogin.classList.add('active'); tabReg.classList.remove('active');
    btnLabel.textContent = 'LAUNCH'; errEl.classList.add('hidden');
  });
  tabReg.addEventListener('click', () => {
    mode = 'register'; tabReg.classList.add('active'); tabLogin.classList.remove('active');
    btnLabel.textContent = 'CREATE'; errEl.classList.add('hidden');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('auth-username').value.trim();
    const p = document.getElementById('auth-password').value;
    errEl.classList.add('hidden');
    audio.click();
    try {
      const res = mode === 'login' ? await api.login(u, p) : await api.register(u, p);
      api.setToken(res.token);
      currentUser = res.username;
      isAdmin     = !!res.is_admin;
      localStorage.setItem('absorbed_token',    res.token);
      localStorage.setItem('absorbed_user',     res.username);
      localStorage.setItem('absorbed_is_admin', isAdmin ? '1' : '0');
      await loadAndRender();
      showGame();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      audio.error();
    }
  });
}

// ── Game UI ───────────────────────────────────────────────────────────────────
function wireGameUI() {
  document.getElementById('btn-logout').addEventListener('click', () => {
    clearInterval(pollTimer);
    clearInterval(adminRefreshTimer);
    localStorage.clear();
    socket?.disconnect();
    showAuth();
    audio.click();
  });

  document.getElementById('btn-admin').addEventListener('click', () => {
    audio.click();
    openAdminPanel();
  });

  document.getElementById('btn-devpin').addEventListener('click', () => {
    if (isAdmin) { toast('Developer mode already active', 'purple'); return; }
    const pin = prompt('Enter developer PIN:');
    if (pin === '4304') {
      activateAdminMode();
    } else if (pin !== null) {
      toast('Wrong PIN', 'red');
    }
  });
  document.getElementById('nav-devpin').addEventListener('click', () => {
    if (isAdmin) { toast('Developer mode already active', 'purple'); return; }
    const pin = prompt('Enter developer PIN:');
    if (pin === '4304') {
      activateAdminMode();
    } else if (pin !== null) {
      toast('Wrong PIN', 'red');
    }
  });

  document.getElementById('build-upgrade-star').addEventListener('click', async () => {
    audio.click();
    try {
      const res = await api.upgradeStar();
      toast(`⭐ ${res.message}`, 'indigo');
      audio.build();
      await loadAndRender();
    } catch (err) { toast(err.message, 'red'); audio.error(); }
  });

  document.getElementById('close-planet').addEventListener('click', closePlanetPanel);

  // Planet Viewer
  document.getElementById('btn-inspect-planet').addEventListener('click', () => {
    if (selectedPlanet) openPlanetViewer(selectedPlanet);
  });
  document.getElementById('btn-build-trade-center').addEventListener('click', () => {
    if (selectedPlanet) buildTradeCenter(selectedPlanet);
  });
  document.getElementById('planet-viewer-close').addEventListener('click', closePlanetViewer);
  document.getElementById('btn-destroy-planet').addEventListener('click', () => {
    if (_viewerPlanet) destroyPlanet(_viewerPlanet);
  });

  // Rename buttons
  document.getElementById('btn-rename-system').addEventListener('click', () => handleRenameSystem());
  document.getElementById('btn-rename-panel-planet').addEventListener('click', () => handleRenamePlanet(selectedPlanet));
  document.getElementById('btn-rename-viewer-planet').addEventListener('click', () => handleRenamePlanet(_viewerPlanet));

  document.getElementById('btn-upgrade-planet').addEventListener('click', async () => {
    if (!selectedPlanet) return;
    audio.click();
    openCouncilModal(selectedPlanet);
  });

  // Galaxy
  document.getElementById('btn-galaxy').addEventListener('click', () => { audio.click(); openGalaxy(); });
  document.getElementById('galaxy-close').addEventListener('click', () => {
    document.getElementById('galaxy-modal').classList.add('hidden');
  });
  document.getElementById('galaxy-refresh').addEventListener('click', () => openGalaxy());

  // Battles
  document.getElementById('btn-battles').addEventListener('click', () => { audio.click(); openBattleLog(); });
  document.getElementById('battles-close').addEventListener('click', () => {
    document.getElementById('battles-modal').classList.add('hidden');
  });

  // Chat
  document.getElementById('btn-chat').addEventListener('click', () => {
    const p = document.getElementById('chat-panel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) document.getElementById('chat-input').focus();
    audio.click();
  });
  document.getElementById('chat-close').addEventListener('click', () => {
    document.getElementById('chat-panel').classList.add('hidden');
  });
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const msg   = input.value.trim();
    if (!msg) return;
    socket?.emit('chat:message', msg);
    input.value = '';
  });

  // Orbit modal
  document.getElementById('orbit-cancel').addEventListener('click', () => {
    document.getElementById('orbit-modal').classList.add('hidden');
    pendingBuildType = null;
  });

  // Battle dismiss
  document.getElementById('battle-dismiss').addEventListener('click', () => {
    document.getElementById('battle-overlay').classList.add('hidden');
  });

  wireMobileNav();
}

// ── Mobile bottom nav wiring ──────────────────────────────────────────────────
function wireMobileNav() {
  const buildPanel = document.getElementById('build-panel');
  const backdrop   = document.getElementById('build-sheet-backdrop');

  const openBuildSheet = () => {
    if (selectedPlanet) closePlanetPanel();
    buildPanel.classList.add('sheet-open');
    backdrop.classList.remove('hidden');
  };
  const closeBuildSheet = () => {
    buildPanel.classList.remove('sheet-open');
    backdrop.classList.add('hidden');
  };

  document.getElementById('nav-build').addEventListener('click', () => {
    audio.click();
    buildPanel.classList.contains('sheet-open') ? closeBuildSheet() : openBuildSheet();
  });
  document.getElementById('build-panel-close')?.addEventListener('click', () => closeBuildSheet());
  backdrop.addEventListener('click', () => closeBuildSheet());

  document.getElementById('nav-galaxy').addEventListener('click',  () => { audio.click(); closeBuildSheet(); openGalaxy(); });
  document.getElementById('nav-battles').addEventListener('click', () => { audio.click(); closeBuildSheet(); openBattleLog(); });
  document.getElementById('nav-chat').addEventListener('click', () => {
    audio.click();
    closeBuildSheet();
    const p = document.getElementById('chat-panel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) document.getElementById('chat-input').focus();
  });
  document.getElementById('nav-admin')?.addEventListener('click', () => {
    audio.click();
    closeBuildSheet();
    openAdminPanel();
  });
  document.getElementById('nav-logout').addEventListener('click', () => {
    clearInterval(pollTimer);
    clearInterval(adminRefreshTimer);
    localStorage.clear();
    socket?.disconnect();
    showAuth();
    audio.click();
  });
}

// ── Planet type picker (left panel) ──────────────────────────────────────────
function buildPlanetTypePicker() {
  const container = document.getElementById('planet-type-picker');
  container.innerHTML = '';
  for (const [type, cfg] of Object.entries(PLANET_TYPES)) {
    const btn = document.createElement('button');
    btn.className = 'planet-type-btn';
    btn.dataset.type = type;
    btn.innerHTML = `<span class="text-lg leading-none">${cfg.icon}</span><span class="text-xs capitalize leading-tight">${type}</span>`;
    btn.title = cfg.desc;
    btn.addEventListener('click', () => { audio.click(); selectPlanetType(type); });
    container.appendChild(btn);
  }
}

function selectPlanetType(type) {
  pendingBuildType = type;
  document.getElementById('orbit-modal-type').textContent = type;
  buildOrbitSlotList();
  // Close build sheet on mobile before showing orbit picker
  if (window.innerWidth < 768) {
    document.getElementById('build-panel').classList.remove('sheet-open');
    document.getElementById('build-sheet-backdrop').classList.add('hidden');
  }
  document.getElementById('orbit-modal').classList.remove('hidden');
  gsap.from('#orbit-modal > div', { opacity: 0, scale: 0.9, duration: 0.25, ease: 'back.out(1.7)' });
}

function buildOrbitSlotList() {
  const slots   = document.getElementById('orbit-slot-list');
  const occupied = (gameState?.planets || []).map(p => p.orbit_index);
  const queued   = (gameState?.queue  || [])
    .filter(q => q.action === 'new_planet')
    .map(q => JSON.parse(q.payload || '{}').orbit_index)
    .filter(x => x != null);
  const isFirstFree = (occupied.length === 0 && queued.length === 0);

  // Show/hide the free-planet hint in the orbit modal
  const hint = document.getElementById('orbit-free-hint');
  if (hint) hint.classList.toggle('hidden', !isFirstFree);

  slots.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const isOccupied = occupied.includes(i) || queued.includes(i);
    const btn = document.createElement('button');
    btn.className = `orbit-slot-btn ${isOccupied ? 'opacity-30 cursor-not-allowed' : ''}`;
    btn.disabled  = isOccupied;
    const costLabel = isFirstFree && !isOccupied
      ? '<span class="ml-auto text-xs text-green-400 font-bold">FREE · instant</span>'
      : `<span class="ml-auto text-xs text-slate-500">${isOccupied ? '● occupied' : '○ free'}</span>`;
    btn.innerHTML = `<i class="fa-solid fa-ring text-indigo-400 mr-2"></i>Orbit ${i + 1}
      ${costLabel}`;
    if (!isOccupied) {
      btn.addEventListener('click', () => triggerBuildPlanet(i));
    }
    slots.appendChild(btn);
  }
}

async function triggerBuildPlanet(orbitIndex) {
  if (!pendingBuildType) return;
  document.getElementById('orbit-modal').classList.add('hidden');
  audio.build();
  try {
    const res = await api.buildPlanet(orbitIndex, pendingBuildType);
    toast(`🚀 Building ${pendingBuildType} planet in Orbit ${orbitIndex + 1}!`, 'indigo');
    const eta = Math.ceil((res.complete_at - Date.now() / 1000));
    if (eta > 2) toast(`⏱ Ready in ~${eta}s`, 'slate');
    pendingBuildType = null;
    await loadAndRender();
  } catch (err) { toast(err.message, 'red'); audio.error(); }
}

// Called by renderer when empty orbit ring clicked
function onOrbitClick(orbitIndex) {
  if (!pendingBuildType) {
    toast('Select a planet type on the left first.', 'slate');
    return;
  }
  triggerBuildPlanet(orbitIndex);
}

// ── Planet click → detail panel ───────────────────────────────────────────────
function onPlanetClick(planet) {
  audio.click();
  selectedPlanet = planet;
  const panel = document.getElementById('planet-panel');
  const cfg   = PLANET_TYPES[planet.type] || { icon: '🪐' };
  const prod  = PROD[planet.type] || {};

  document.getElementById('planet-icon').textContent    = cfg.icon;
  document.getElementById('planet-icon').style.background = cfg.color + '44';
  document.getElementById('planet-name').textContent    = planet.name;
  document.getElementById('planet-type').textContent    = planet.type;
  document.getElementById('p-level').textContent        = `⭐ ${planet.level}`;
  document.getElementById('p-orbit').textContent        = `Ring ${planet.orbit_index + 1}`;
  document.getElementById('p-energy').textContent       = `${((prod.energy || 0) * planet.level).toFixed(1)}`;
  document.getElementById('p-matter').textContent       = `${((prod.matter || 0) * planet.level).toFixed(1)}`;
  document.getElementById('p-credits').textContent      = `${((prod.credits || 0) * planet.level).toFixed(1)}`;
  const ATTACK_W = { rocky: 1.2, volcanic: 2, crystal: 1.5, gas: 0.8, ocean: 0.9, ice: 0.7 };
  document.getElementById('p-atk').textContent          = `${Math.round(planet.level * (ATTACK_W[planet.type] || 1) * 10)}`;

  // Upgrade cost preview (matches server BUILD_CONFIG: scale = level² for L1-5, 25×3^(level-5) for L6+)
  const upScale = planet.level <= 5
    ? planet.level * planet.level
    : 25 * Math.pow(3, planet.level - 5);
  const upCost = { m: Math.round(280 * upScale), e: Math.round(200 * upScale), c: Math.round(70 * upScale) };
  document.getElementById('upgrade-cost').textContent =
    `(M:${upCost.m} E:${upCost.e} C:${upCost.c})`;

  // Buildings section
  const allBuildings = (gameState?.buildings || []).filter(b => b.planet_id === planet.id);
  const maxSlots     = Math.max(1, Math.ceil((planet.size_scale || 1.0) * 1.5));
  const usedSlots    = allBuildings.length;
  document.getElementById('p-building-slots').textContent = `${usedSlots}/${maxSlots} slots used`;

  const buildList = document.getElementById('p-building-list');
  buildList.innerHTML = '';
  if (allBuildings.length === 0) {
    buildList.innerHTML = '<span class="text-[10px] text-slate-600">No buildings yet</span>';
  } else {
    for (const b of allBuildings) {
      const item = document.createElement('div');
      item.className = 'flex items-center gap-1.5 text-xs text-slate-300 bg-white/5 rounded px-2 py-1';
      item.innerHTML = '<i class="fa-solid fa-store text-amber-400 text-[10px]"></i> Trade Center';
      buildList.appendChild(item);
    }
  }

  const totalPlanets = (gameState?.planets || []).length;
  const slotsFull    = usedSlots >= maxSlots;
  const btnTC        = document.getElementById('btn-build-trade-center');
  const hintTC       = document.getElementById('trade-center-hint');
  btnTC.disabled = totalPlanets < 2 || slotsFull;
  btnTC.classList.toggle('opacity-40', totalPlanets < 2 || slotsFull);
  hintTC.classList.toggle('hidden', totalPlanets >= 2);

  const inQueue  = (gameState?.queue || []).some(q => q.planet_id === planet.id && !q.done);
  const nowSec   = Math.floor(Date.now() / 1000);
  const isLocked = (planet.council_denied_until || 0) > nowSec;

  document.getElementById('btn-upgrade-planet').disabled = inQueue || isLocked;

  // Queue status (in-progress text)
  document.getElementById('upgrade-status').classList.toggle('hidden', !inQueue);
  document.getElementById('upgrade-status').textContent = inQueue ? '⏳ Upgrade in progress…' : '';

  // Council watch banner
  const watchPanel = document.getElementById('council-watch-panel');
  watchPanel.classList.toggle('hidden', !isLocked);
  watchPanel.classList.toggle('flex', isLocked);
  if (isLocked) {
    // Clear any previous ticker
    if (window._councilTicker) clearInterval(window._councilTicker);
    const deniedUntil = planet.council_denied_until;
    const tick = () => {
      const s = Math.max(0, deniedUntil - Math.floor(Date.now() / 1000));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      document.getElementById('council-watch-timer').textContent = `${h}h ${m}m ${sec}s`;
      if (s <= 0) {
        clearInterval(window._councilTicker);
        watchPanel.classList.add('hidden');
        watchPanel.classList.remove('flex');
        document.getElementById('btn-upgrade-planet').disabled = false;
      }
    };
    tick();
    window._councilTicker = setInterval(tick, 1000);
  } else {
    if (window._councilTicker) { clearInterval(window._councilTicker); window._councilTicker = null; }
  }

  if (window.innerWidth < 768) {
    // Mobile: CSS transition slides sheet up from bottom
    document.getElementById('build-panel').classList.remove('sheet-open');
    document.getElementById('build-sheet-backdrop').classList.add('hidden');
    panel.classList.remove('hidden');
  } else {
    panel.classList.remove('hidden');
    gsap.from(panel, { x: 30, opacity: 0, duration: 0.3, ease: 'power2.out' });
  }
}

function closePlanetPanel() {
  selectedPlanet = null;
  if (window._councilTicker) { clearInterval(window._councilTicker); window._councilTicker = null; }
  const panel = document.getElementById('planet-panel');
  if (window.innerWidth < 768) {
    panel.classList.add('hidden');
  } else {
    gsap.to(panel, { x: 30, opacity: 0, duration: 0.2, onComplete: () => {
      panel.classList.add('hidden'); panel.style.opacity = 1; panel.style.transform = '';
    }});
  }
}

// ── Build Trade Center ────────────────────────────────────────────────────────
async function buildTradeCenter(planet) {
  audio.build?.();
  try {
    const res = await api.buildBuilding(planet.id, 'trade_center');
    toast(`🏪 Trade Center built on ${planet.name}!`, 'amber');
    await loadAndRender();
  } catch (err) { toast(err.message, 'red'); audio.error?.(); }
}
// ── Ultimate Universe Council modal ─────────────────────────────────────────────────
function openCouncilModal(planet) {
  const modal      = document.getElementById('council-modal');
  const body       = document.getElementById('council-letter-body');
  const loading    = document.getElementById('council-loading');
  const header     = document.getElementById('council-verdict-header');
  const dismiss    = document.getElementById('council-dismiss');

  // Show modal immediately with loading state
  body.textContent = '';
  body.classList.add('hidden');
  loading.classList.remove('hidden');
  loading.classList.add('flex');
  header.classList.add('hidden');
  document.getElementById('council-divider').classList.add('hidden');
  dismiss.textContent = 'Please wait…';
  dismiss.disabled    = true;
  dismiss.className   = 'w-full py-2.5 rounded-xl text-sm font-bold tracking-wide transition-all bg-slate-800 text-slate-500 cursor-not-allowed';

  modal.classList.remove('hidden');
  gsap.from('#council-modal > div', { opacity: 0, scale: 0.92, duration: 0.35, ease: 'back.out(1.4)' });

  // Call API while modal is visible
  api.upgradePlanet(planet.id).then(res => {
    _fillCouncilModal(res, planet);
  }).catch(err => {
    // Hard error — could be lockout, resources, already queued, etc.
    loading.classList.add('hidden');
    loading.classList.remove('flex');
    body.classList.remove('hidden');

    // Parse lockout specifically
    let isLockout = false;
    let lockoutMsg = err.message || 'An error occurred.';
    try {
      // api._req throws with err.message = server's error string
      if (lockoutMsg === 'council_lockout') { isLockout = true; lockoutMsg = 'The Council has banned this petition. Try again later.'; }
    } catch {}

    body.textContent = lockoutMsg;
    header.classList.remove('hidden');
    document.getElementById('council-verdict-icon').textContent  = isLockout ? '\uD83D\uDCDC' : '\u26A0\uFE0F';
    document.getElementById('council-verdict-label').textContent = isLockout ? 'PETITION BANNED' : 'Request Failed';
    document.getElementById('council-verdict-label').className   = 'text-base font-black uppercase tracking-widest text-red-400';
    document.getElementById('council-verdict-sub').textContent   = '';
    document.getElementById('council-seal').textContent          = isLockout ? '\u231B' : '\u274C';
    document.getElementById('council-divider').classList.remove('hidden');
    dismiss.textContent = 'Dismiss';
    dismiss.disabled    = false;
    dismiss.className   = 'w-full py-2.5 rounded-xl text-sm font-bold tracking-wide transition-all bg-slate-800 hover:bg-slate-700 text-slate-300';
    const newBtn = dismiss.cloneNode(true);
    newBtn.textContent = 'Dismiss'; newBtn.disabled = false;
    newBtn.className = dismiss.className;
    dismiss.replaceWith(newBtn);
    newBtn.addEventListener('click', () => {
      document.getElementById('council-modal').classList.add('hidden');
      loadAndRender(); // refresh panel so lockout countdown shows
    });
    audio.error?.();
  });
}

function _fillCouncilModal(res, planet) {
  const body     = document.getElementById('council-letter-body');
  const loading  = document.getElementById('council-loading');
  const header   = document.getElementById('council-verdict-header');
  const divider  = document.getElementById('council-divider');
  const dismiss  = document.getElementById('council-dismiss');
  const approved = res.verdict === 'approved';

  loading.classList.add('hidden');
  loading.classList.remove('flex');
  body.classList.remove('hidden');
  header.classList.remove('hidden');
  divider.classList.remove('hidden');

  // Style verdict header
  document.getElementById('council-verdict-icon').textContent  = approved ? '\u2705' : '\u274C';
  document.getElementById('council-verdict-icon').className   = `w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 ${approved ? 'bg-green-900/50' : 'bg-red-900/50'}`;
  document.getElementById('council-verdict-label').textContent = approved ? 'UPGRADE APPROVED' : 'UPGRADE DENIED';
  document.getElementById('council-verdict-label').className   = `text-base font-black uppercase tracking-widest ${approved ? 'text-green-400' : 'text-red-400'}`;
  document.getElementById('council-verdict-sub').textContent   = approved
    ? `${planet.name} may ascend to Level ${planet.level + 1}`
    : `${planet.name} shall remain at Level ${planet.level}`;
  document.getElementById('council-seal').textContent          = approved ? '\u2728' : '\uD83D\uDCDC';

  // Letter body with typewriter effect
  body.textContent = '';
  const text = res.letter || '';
  let i = 0;
  const type = () => {
    if (i < text.length) { body.textContent += text[i++]; requestAnimationFrame(type); }
  };
  requestAnimationFrame(type);

  // Dismiss button
  dismiss.disabled  = false;
  dismiss.textContent = approved ? '\uD83D\uDE80  Proceed with Upgrade' : '\uD83D\uDDE1\uFE0F  Challenge the Council Next Time';
  dismiss.className = approved
    ? 'w-full py-2.5 rounded-xl text-sm font-bold tracking-wide transition-all bg-green-700 hover:bg-green-600 text-white'
    : 'w-full py-2.5 rounded-xl text-sm font-bold tracking-wide transition-all bg-red-900/60 hover:bg-red-800/70 text-red-300';

  // Wire dismiss
  const newBtn = dismiss.cloneNode(true);
  newBtn.textContent = dismiss.textContent;
  newBtn.className   = dismiss.className;
  newBtn.disabled    = false;
  dismiss.replaceWith(newBtn);
  newBtn.addEventListener('click', async () => {
    document.getElementById('council-modal').classList.add('hidden');
    if (approved) {
      toast(`\uD83D\uDD3A ${res.message}`, 'violet');
      audio.upgrade?.();
      await loadAndRender();
    } else {
      toast('\uD83D\uDCDC The Council has spoken. Upgrade denied.', 'red');
      await loadAndRender(); // refresh panel so lockout countdown appears
    }
  });

  if (approved) audio.build?.();
  else          audio.error?.();
}

// ── Rename helpers ────────────────────────────────────────────────────────────────────
function _inlineRename(labelEl, buttonEl, currentValue, onSave) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue;
  input.className = 'bg-transparent border-b border-indigo-400 text-white text-xs outline-none min-w-0 w-full max-w-[120px]';
  labelEl.replaceWith(input);
  buttonEl.classList.add('hidden');
  input.focus(); input.select();
  const finish = async () => {
    const val = input.value.trim();
    input.replaceWith(labelEl);
    buttonEl.classList.remove('hidden');
    if (val && val !== currentValue) await onSave(val);
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = currentValue; input.blur(); } });
}

async function handleRenameSystem() {
  const labelEl  = document.getElementById('sys-name-label');
  const buttonEl = document.getElementById('btn-rename-system');
  const current  = labelEl.textContent.trim();
  _inlineRename(labelEl, buttonEl, current, async (newName) => {
    try {
      const res = await api.renameSystem(newName);
      document.getElementById('sys-name-label').textContent = res.name;
      if (gameState?.solar_system) gameState.solar_system.name = res.name;
      toast(`System renamed to “${res.name}”`, 'indigo');
    } catch (err) { toast(err.message, 'red'); }
  });
}

async function handleRenamePlanet(planet) {
  if (!planet) return;
  // Use whichever context is currently visible — viewer takes priority
  const viewerOpen = !document.getElementById('planet-viewer').classList.contains('hidden');
  const [labelId, btnId] = viewerOpen
    ? ['pv-name',      'btn-rename-viewer-planet']
    : ['planet-name',  'btn-rename-panel-planet'];
  const labelEl  = document.getElementById(labelId);
  const buttonEl = document.getElementById(btnId);
  if (!labelEl) return;
  const current = planet.name || '';
  _inlineRename(labelEl, buttonEl, current, async (newName) => {
    try {
      const res = await api.renamePlanet(planet.id, newName);
      planet.name = res.name;
      const pvName = document.getElementById('pv-name');
      const pName  = document.getElementById('planet-name');
      if (pvName) pvName.textContent = res.name;
      if (pName)  pName.textContent  = res.name;
      toast(`Renamed to “${res.name}”`, 'indigo');
      await loadAndRender();
    } catch (err) { toast(err.message, 'red'); }
  });
}
// ── Planet Viewer (full-screen 3D inspector) ────────────────────────────────
let _viewerPlanet = null;

function openPlanetViewer(planet) {
  _viewerPlanet = planet;
  const viewer = document.getElementById('planet-viewer');
  const wrap   = document.getElementById('planet-viewer-canvas-wrap');
  const cfg    = PLANET_TYPES[planet.type] || { icon: '🪐' };
  const prod   = PROD[planet.type] || {};

  // Reset destroy button state
  const btnDestroy = document.getElementById('btn-destroy-planet');
  const destroyStatus = document.getElementById('pv-destroy-status');
  if (btnDestroy) { btnDestroy.disabled = false; }
  if (destroyStatus) { destroyStatus.classList.add('hidden'); }

  // Populate stats sidebar
  document.getElementById('pv-icon').textContent    = cfg.icon;
  document.getElementById('pv-name').textContent    = planet.name;
  document.getElementById('pv-type').textContent    = `${planet.type} planet`;
  document.getElementById('pv-level').textContent   = `⭐ ${planet.level}`;
  document.getElementById('pv-orbit').textContent   = `Ring ${planet.orbit_index + 1}`;
  document.getElementById('pv-energy').textContent  = `${((prod.energy || 0) * planet.level).toFixed(1)}`;
  document.getElementById('pv-matter').textContent  = `${((prod.matter || 0) * planet.level).toFixed(1)}`;
  document.getElementById('pv-credits').textContent = `${((prod.credits || 0) * planet.level).toFixed(1)}`;
  const ATTACK_W = { rocky: 1.2, volcanic: 2, crystal: 1.5, gas: 0.8, ocean: 0.9, ice: 0.7 };
  document.getElementById('pv-atk').textContent     = `${Math.round(planet.level * (ATTACK_W[planet.type] || 1) * 10)}`;
  document.getElementById('pv-self-rot').textContent  = planet.self_rotation  ? `${(planet.self_rotation * 1000).toFixed(1)}x` : '—';
  document.getElementById('pv-orb-spd').textContent   = planet.orbital_speed   ? `${Number(planet.orbital_speed).toFixed(2)}x` : '—';
  document.getElementById('pv-size').textContent      = planet.size_scale      ? `${Number(planet.size_scale).toFixed(2)}x`    : '—';
  document.getElementById('pv-moons').textContent     = planet.moon_count != null ? String(planet.moon_count) : '0';

  // Moon list — each moon is clickable to expand its specs
  const moonList = document.getElementById('pv-moon-list');
  const moons    = planet.moon_data ? (typeof planet.moon_data === 'string' ? JSON.parse(planet.moon_data) : planet.moon_data) : [];
  if (moons.length > 0) {
    moonList.classList.remove('hidden');
    moonList.innerHTML = '<h3 class="text-slate-400 font-semibold uppercase tracking-wider text-[10px] mb-1">Moons</h3>';
    moons.forEach((m, i) => {
      const modelName = m.model_file?.replace('.glb','').replace(/_/g,' ') || 'Unknown';
      const item = document.createElement('div');
      item.className = 'rounded hover:bg-white/5 cursor-pointer transition-colors';

      const header = document.createElement('div');
      header.className = 'flex items-center justify-between py-0.5 text-slate-300';
      header.innerHTML = `<span class="flex items-center gap-1.5"><span class="text-sm">\u{1F311}</span><span class="font-medium">Moon ${i + 1}</span></span><i class="fa-solid fa-chevron-right text-slate-500 text-[10px] transition-transform"></i>`;

      const detail = document.createElement('div');
      detail.className = 'text-[11px] text-slate-400 pl-5 pb-1.5 flex-col gap-0.5 hidden';
      detail.innerHTML = [
        `<div class="flex justify-between"><span>Model</span><span class="text-slate-300 truncate max-w-[110px]" title="${modelName}">${modelName}</span></div>`,
        `<div class="flex justify-between"><span>Orbit Speed</span><span class="text-slate-300">${m.orbital_speed != null ? m.orbital_speed.toFixed(3) : '\u2014'}</span></div>`,
        `<div class="flex justify-between"><span>Orbit Radius</span><span class="text-slate-300">${m.orbital_radius != null ? m.orbital_radius.toFixed(2) : '\u2014'}</span></div>`,
        `<div class="flex justify-between"><span>Size Scale</span><span class="text-slate-300">${m.size_scale != null ? m.size_scale.toFixed(2) : '\u2014'}</span></div>`,
      ].join('');

      header.addEventListener('click', () => {
        const collapsed = detail.classList.toggle('hidden');
        detail.classList.toggle('flex', !collapsed);
        header.querySelector('i').style.transform = collapsed ? '' : 'rotate(90deg)';
      });

      item.appendChild(header);
      item.appendChild(detail);
      moonList.appendChild(item);
    });
  } else {
    moonList.classList.add('hidden');
  }

  viewer.classList.remove('hidden');
  // Defer so the panel is visible and wrap has real dimensions before Three.js sizes the canvas
  requestAnimationFrame(() => planet3d.openViewer(planet, wrap));
}

function closePlanetViewer() {
  planet3d.closeViewer();
  _viewerPlanet = null;
  document.getElementById('planet-viewer').classList.add('hidden');
}

async function destroyPlanet(planet) {
  const btn    = document.getElementById('btn-destroy-planet');
  const status = document.getElementById('pv-destroy-status');
  btn.disabled = true;
  status.classList.remove('hidden');
  audio.error?.();

  // Close the inspect panel immediately so the player sees their solar system
  const savedPlanet = { ...planet };
  closePlanetPanel();
  closePlanetViewer();

  // Trigger the visual explosion on the main 2D screen
  renderer.spawnPlanetExplosion(savedPlanet.id, async () => {
    try {
      await api.deletePlanet(savedPlanet.id);
      planet3d.unregisterPlanet(savedPlanet.id);
      toast(`💥 ${savedPlanet.name} has been destroyed.`, 'red');
      await loadAndRender();
    } catch (err) {
      toast(err.message || 'Destroy failed.', 'red');
    }
  });
}

// ── Game state load & render ──────────────────────────────────────────────────
async function loadAndRender() {
  try {
    const completed = await api.processQueue();
    if (completed.completed?.length) {
      for (const c of completed.completed) {
        if (c.action === 'new_planet')    { toast(`✅ ${c.name} (${c.type}) colonized!`, 'green');  audio.build(); }
        if (c.action === 'upgrade_planet'){ toast(`✅ ${c.name} upgraded to Lv ${c.level}!`, 'violet'); audio.upgrade(); }
        if (c.action === 'upgrade_star')  { toast('✅ Star upgraded!', 'yellow'); audio.upgrade(); renderer.spawnBurst(0xFFCC00); }
      }
    }
  } catch { /* queue may fail if no auth yet */ }

  gameState = await api.getState();
  const sys = gameState.solar_system;

  // HUD
  document.getElementById('res-energy' ).textContent = fmt(sys.energy);
  document.getElementById('res-matter' ).textContent = fmt(sys.matter);
  document.getElementById('res-credits').textContent = fmt(sys.credits);
  document.getElementById('sys-name-label').textContent = sys.name;

  // Admin: per-resource edit pencil buttons in HUD (re-inject each render)
  if (isAdmin) {
    [['energy','res-energy'],['matter','res-matter'],['credits','res-credits']].forEach(([res, elId]) => {
      const badge = document.getElementById(elId)?.closest('.res-badge');
      if (!badge || badge.querySelector('.admin-res-edit')) return;
      const btn = document.createElement('button');
      btn.className = 'admin-res-edit text-[9px] text-purple-400 hover:text-purple-200 ml-0.5 leading-none';
      btn.title = `Set ${res}`;
      btn.innerHTML = '&#9998;';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cur = Math.round(gameState?.solar_system?.[res] ?? 0);
        const raw = prompt(`Set ${res} (current: ${cur}):`, cur);
        if (raw === null) return;
        const v = Math.max(0, Math.min(999999, parseInt(raw) || 0));
        try {
          await api.adminSetResources(
            currentUserId,
            res === 'energy'  ? v : null,
            res === 'matter'  ? v : null,
            res === 'credits' ? v : null,
          );
          toast(`\u2705 ${res} \u2192 ${v}`, 'purple');
          await loadAndRender();
        } catch (err) { toast(err.message, 'red'); }
      });
      badge.appendChild(btn);
    });
  }

  const starTypes = { yellow_dwarf: 'Yellow Dwarf', red_dwarf: 'Red Dwarf', blue_giant: 'Blue Giant', white_dwarf: 'White Dwarf', neutron: 'Neutron' };
  document.getElementById('star-info').textContent = `Lv ${sys.star_level} — ${starTypes[sys.star_type] || sys.star_type}`;

  const nextStar = sys.star_level;
  // Star upgrade cost matches server BUILD_CONFIG: level² × base
  document.getElementById('star-cost').textContent =
    `M:${nextStar*nextStar*1200} E:${nextStar*nextStar*800} C:${nextStar*nextStar*300}`;

  renderQueue(gameState.queue);

  // Sync trade ships with number of trade centers built
  const tradeCenterCount = (gameState.buildings || []).filter(b => b.type === 'trade_center').length;
  renderer.setTradeShipCount(tradeCenterCount, gameState.planets);

  renderer.render(gameState);

  // Update open planet panel if still open
  if (selectedPlanet) {
    const fresh = gameState.planets.find(p => p.id === selectedPlanet.id);
    if (fresh) onPlanetClick(fresh); else closePlanetPanel();
  }
}

function renderQueue(queue = []) {
  const el         = document.getElementById('build-queue-list');
  const skipAllBtn = document.getElementById('queue-skip-all');
  el.innerHTML = '';
  const active = queue.filter(q => !q.done);

  // Admin skip-all button — re-clone to clear stale listeners
  if (skipAllBtn) {
    if (isAdmin && active.length) {
      skipAllBtn.classList.remove('hidden');
      const fresh = skipAllBtn.cloneNode(true);
      skipAllBtn.replaceWith(fresh);
      fresh.addEventListener('click', async () => {
        try {
          await api.adminCompleteQueue(undefined);
          toast('⚡ All timers skipped!', 'purple');
          await loadAndRender();
        } catch (err) { toast(err.message, 'red'); }
      });
    } else {
      skipAllBtn.classList.add('hidden');
    }
  }

  if (!active.length) { el.innerHTML = '<span class="text-slate-600 text-xs px-1">No active builds</span>'; return; }
  for (const item of active) {
    const secsLeft = Math.max(0, item.complete_at - Math.floor(Date.now() / 1000));
    const label    = item.action === 'new_planet'    ? `${JSON.parse(item.payload || '{}').type || '?'} planet`
                   : item.action === 'upgrade_planet' ? 'Upgrade planet'
                   : item.action === 'upgrade_star'   ? 'Star upgrade' : item.action;
    const div = document.createElement('div');
    div.className = 'queue-item';
    const etaSpan = document.createElement('span');
    etaSpan.className = 'queue-eta';
    etaSpan.dataset.eta = item.complete_at;
    etaSpan.textContent = secsLeft > 0 ? `⏱ ${secsLeft}s` : '✅ Done!';
    div.innerHTML = `<span class="truncate capitalize">${label}</span>`;
    div.appendChild(etaSpan);
    if (isAdmin) {
      const skip = document.createElement('button');
      skip.innerHTML = '⚡';
      skip.title = 'Skip all timers';
      skip.className = 'ml-1 text-yellow-400 hover:text-yellow-100 text-sm font-bold leading-none shrink-0';
      skip.addEventListener('click', async () => {
        try {
          await api.adminCompleteQueue(undefined);
          toast('⚡ Skipped!', 'purple');
          await loadAndRender();
        } catch (err) { toast(err.message, 'red'); }
      });
      div.appendChild(skip);
    }
    el.appendChild(div);
  }
}

// Live countdown for queue items
setInterval(() => {
  document.querySelectorAll('.queue-eta').forEach(el => {
    const eta  = parseInt(el.dataset.eta, 10);
    const left = Math.max(0, eta - Math.floor(Date.now() / 1000));
    el.textContent = left > 0 ? `⏱ ${left}s` : '✅ Done!';
  });
}, 1000);

// ── Galaxy map ────────────────────────────────────────────────────────────────
async function openGalaxy() {
  const modal = document.getElementById('galaxy-modal');
  const list  = document.getElementById('galaxy-list');
  modal.classList.remove('hidden');
  list.innerHTML = '<p class="text-slate-500 text-sm px-2">Scanning galaxy…</p>';

  try {
    const data = await api.getGalaxy();
    list.innerHTML = '';
    if (!data.players.length) {
      list.innerHTML = '<p class="text-slate-500 text-sm px-2">No other commanders found yet.</p>';
      return;
    }
    for (const p of data.players) {
      const STAR_COLORS = { yellow_dwarf: '#FFE066', red_dwarf: '#FF5533', blue_giant: '#88CCFF', white_dwarf: '#EEEEFF', neutron: '#00FFEE' };
      const starColor = STAR_COLORS[p.star_type] || '#FFE066';
      const row = document.createElement('div');
      row.className = 'galaxy-row';
      row.innerHTML = `
        <div class="w-9 h-9 rounded-full flex items-center justify-center text-lg shrink-0"
             style="background: ${starColor}33; border: 1.5px solid ${starColor}88">✦</div>
        <div class="flex-1 min-w-0">
          <p class="font-bold text-sm text-white truncate">${p.username}</p>
          <p class="text-xs text-slate-400">${p.name} · ${p.planet_count} planets · Star Lv ${p.star_level}</p>
        </div>
        <button class="btn-attack shrink-0" data-uid="${p.id}" data-uname="${p.username}">
          <i class="fa-solid fa-bolt mr-1"></i>Attack
        </button>`;
      list.appendChild(row);
    }
    list.querySelectorAll('.btn-attack').forEach(btn => {
      btn.addEventListener('click', () => launchBattle(btn.dataset.uid, btn.dataset.uname));
    });
  } catch (err) { list.innerHTML = `<p class="text-red-400 text-sm">${err.message}</p>`; }
}

async function launchBattle(uid, uname) {
  document.getElementById('galaxy-modal').classList.add('hidden');
  audio.battle();
  renderer.flashBattle();

  const overlay = document.getElementById('battle-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('battle-title').textContent = `Attacking ${uname}…`;
  document.getElementById('battle-anim').textContent  = '⚔️';
  document.getElementById('battle-atk').textContent   = '…';
  document.getElementById('battle-def').textContent   = '…';
  document.getElementById('battle-loot').classList.add('hidden');

  // Animate the swords
  gsap.fromTo('#battle-anim', { rotation: -20, scale: 0.8 }, { rotation: 20, scale: 1.2, duration: 0.4, yoyo: true, repeat: 3 });

  try {
    const res = await api.battle(uid);
    document.getElementById('battle-atk').textContent  = res.attacker_power;
    document.getElementById('battle-def').textContent  = res.defender_power;
    document.getElementById('battle-title').textContent = res.outcome === 'victory' ? `🏆 VICTORY!` : `💀 DEFEAT`;

    if (res.outcome === 'victory') {
      audio.victory();
      renderer.spawnBurst(0xFFAA00);
      const loot = res.stolen;
      if (loot.energy + loot.matter + loot.credits > 0) {
        document.getElementById('battle-loot').classList.remove('hidden');
        document.getElementById('battle-loot-text').textContent =
          `⚡${fmt(loot.energy)} 🧱${fmt(loot.matter)} 💰${fmt(loot.credits)}`;
      }
    } else {
      audio.defeat();
      renderer.flashBattle();
    }

    // Emit to Socket.IO so the defender gets notified
    socket?.emit('battle:result', {
      attacker_name: currentUser,
      defender_name: uname,
      outcome: res.outcome,
      stolen: res.stolen,
    });

    await loadAndRender();
  } catch (err) {
    document.getElementById('battle-title').textContent = 'Battle Failed';
    document.getElementById('battle-atk').textContent  = '—';
    document.getElementById('battle-def').textContent  = err.message;
    audio.error();
  }
}

// ── Battle log ────────────────────────────────────────────────────────────────
async function openBattleLog() {
  const modal = document.getElementById('battles-modal');
  const list  = document.getElementById('battle-log-list');
  modal.classList.remove('hidden');
  list.innerHTML = '<p class="text-slate-500 text-sm">Loading…</p>';
  try {
    const data = await api.getBattleLog();
    list.innerHTML = '';
    if (!data.log.length) {
      list.innerHTML = '<p class="text-slate-500 text-sm">No battles recorded.</p>';
      return;
    }
    for (const b of data.log) {
      const isAttacker = (b.attacker_name === currentUser);
      const won        = (b.winner_id && ((isAttacker && b.attacker_name === currentUser) || (!isAttacker && b.defender_name === currentUser)));
      const outcome    = (b.winner_id == null) ? 'Draw' : won ? 'Victory' : 'Defeat';
      const oColor     = outcome === 'Victory' ? 'text-green-400' : outcome === 'Defeat' ? 'text-red-400' : 'text-slate-400';
      const row = document.createElement('div');
      row.className = 'battle-row';
      row.innerHTML = `
        <span class="${oColor} font-bold w-16">${outcome}</span>
        <span class="flex-1 text-xs text-slate-300">
          ${isAttacker ? `You → ${b.defender_name}` : `${b.attacker_name} → You`}
        </span>
        <span class="text-xs text-slate-500">${new Date(b.created_at * 1000).toLocaleTimeString()}</span>`;
      list.appendChild(row);
    }
  } catch (err) { list.innerHTML = `<p class="text-red-400 text-sm">${err.message}</p>`; }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io();
  socket.on('connect', () => socket.emit('register', currentUser));
  socket.on('galaxy:update', ({ online }) => {
    document.getElementById('online-count').textContent = online;
  });
  socket.on('battle:incoming', (data) => {
    audio.notify();
    const msg = data.outcome === 'victory'
      ? `⚠️ ${data.attacker} attacked you — but you held!`
      : `💥 ${data.attacker} attacked and DEFEATED you!`;
    toast(msg, data.outcome === 'victory' ? 'yellow' : 'red');
    loadAndRender();
  });
  socket.on('chat:message', ({ from, text }) => {
    const el = document.getElementById('chat-messages');
    const d  = document.createElement('div');
    d.className = 'chat-msg';
    d.innerHTML = `<span class="font-bold text-indigo-300">${from}:</span> <span>${text}</span>`;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
    if (from !== currentUser) audio.notify();
  });
}

// ── Screen transitions ────────────────────────────────────────────────────────
function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('game-screen').classList.add('hidden');
  gsap.from('#auth-screen > div.relative', { opacity: 0, y: 30, duration: 0.5, ease: 'power2.out' });
}

function showGame() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  gsap.from('#game-screen header', { opacity: 0, y: -20, duration: 0.4, ease: 'power2.out' });
  if (window.innerWidth >= 768) {
    gsap.from('#build-panel', { opacity: 0, x: -30, duration: 0.4, delay: 0.1, ease: 'power2.out' });
  }
  const adminBtn = document.getElementById('btn-admin');
  const navAdmin = document.getElementById('nav-admin');
  if (isAdmin) {
    adminBtn.classList.remove('hidden');
    navAdmin?.classList.remove('hidden');
  } else {
    adminBtn.classList.add('hidden');
    navAdmin?.classList.add('hidden');
  }
  connectSocket();
  startPoll();
}

// ── Admin mode activation (PIN-gated) ───────────────────────────────────────
function activateAdminMode() {
  isAdmin = true;
  // Show admin button + nav
  document.getElementById('btn-admin')?.classList.remove('hidden');
  document.getElementById('nav-admin')?.classList.remove('hidden');
  // Unlock icon → unlocked (desktop + mobile)
  ['btn-devpin', 'nav-devpin'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = id === 'btn-devpin'
      ? '<i class="fa-solid fa-lock-open"></i>'
      : '<i class="fa-solid fa-lock-open"></i><span>Dev</span>';
    el.classList.add('text-purple-400');
    el.classList.remove('text-slate-600', 'text-slate-500', 'hover:text-slate-300');
    el.title = 'Developer mode active';
  });
  // Re-render queue to show skip buttons
  if (gameState) renderQueue(gameState.queue);
  // Inject resource edit pencils
  if (gameState) {
    const sys = gameState.solar_system;
    [['energy','res-energy'],['matter','res-matter'],['credits','res-credits']].forEach(([res, elId]) => {
      const badge = document.getElementById(elId)?.closest('.res-badge');
      if (!badge || badge.querySelector('.admin-res-edit')) return;
      const btn = document.createElement('button');
      btn.className = 'admin-res-edit text-[10px] text-purple-400 hover:text-purple-200 ml-1 leading-none';
      btn.title = `Set ${res}`;
      btn.innerHTML = '&#9998;';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cur = Math.round(gameState?.solar_system?.[res] ?? 0);
        const raw = prompt(`Set ${res} (current: ${cur}):`, cur);
        if (raw === null) return;
        const v = Math.max(0, Math.min(999999, parseInt(raw) || 0));
        try {
          await api.adminSetResources(currentUserId, res==='energy'?v:null, res==='matter'?v:null, res==='credits'?v:null);
          toast(`\u2705 ${res} \u2192 ${v}`, 'purple');
          await loadAndRender();
        } catch (err) { toast(err.message, 'red'); }
      });
      badge.appendChild(btn);
    });
  }
  toast('\uD83D\uDD13 Developer mode active', 'purple');
}

// ── Admin Panel ───────────────────────────────────────────────────────────────
function openAdminPanel() {
  document.getElementById('admin-panel').classList.remove('hidden');
  gsap.from('#admin-panel > div', { opacity: 0, y: 20, duration: 0.3, ease: 'power2.out' });
  wireAdminPanel();
  loadAdminLogs();
  // auto-refresh logs every 5s while open
  clearInterval(adminRefreshTimer);
  adminRefreshTimer = setInterval(() => {
    const panel = document.getElementById('admin-panel');
    if (!panel.classList.contains('hidden')) {
      const active = panel.querySelector('.admin-tab.active')?.dataset.tab;
      if (active === 'logs')  loadAdminLogs();
      if (active === 'users') loadAdminUsers();
      if (active === 'stats') loadAdminStats();
    }
  }, 5000);
}

let _adminPanelWired = false;
function wireAdminPanel() {
  if (_adminPanelWired) return;
  _adminPanelWired = true;

  // close
  document.getElementById('admin-close').addEventListener('click', () => {
    document.getElementById('admin-panel').classList.add('hidden');
    clearInterval(adminRefreshTimer);
  });

  // tab switching
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-tab-pane').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      const pane = document.getElementById(`admin-tab-${btn.dataset.tab}`);
      if (pane) pane.classList.remove('hidden');
      if (btn.dataset.tab === 'logs')  loadAdminLogs();
      if (btn.dataset.tab === 'users') loadAdminUsers();
      if (btn.dataset.tab === 'stats') loadAdminStats();
    });
  });

  // logs controls
  document.getElementById('admin-log-refresh').addEventListener('click', () => loadAdminLogs());
  document.getElementById('admin-log-search').addEventListener('input',   () => { adminLogPage = 0; loadAdminLogs(); });
  document.getElementById('admin-log-level').addEventListener('change',   () => { adminLogPage = 0; loadAdminLogs(); });
  document.getElementById('admin-log-prev').addEventListener('click', () => { if (adminLogPage > 0) { adminLogPage--; loadAdminLogs(); } });
  document.getElementById('admin-log-next').addEventListener('click', () => { adminLogPage++; loadAdminLogs(); });
  document.getElementById('admin-log-clear').addEventListener('click', async () => {
    if (!confirm('Clear ALL logs? This cannot be undone.')) return;
    try {
      await api.adminClearLogs();
      adminLogPage = 0;
      loadAdminLogs();
      toast('Logs cleared', 'purple');
    } catch (err) { toast(err.message, 'red'); }
  });

  // users controls
  document.getElementById('admin-users-refresh').addEventListener('click', () => loadAdminUsers());

  // tools
  document.getElementById('admin-reset-self').addEventListener('click', async () => {
    if (!confirm('Reset your own account to starter values?')) return;
    try {
      await api.adminResetSelf();
      toast('Account reset!', 'purple');
      await loadAndRender();
    } catch (err) { toast(err.message, 'red'); }
  });

  document.getElementById('admin-complete-queue').addEventListener('click', async () => {
    const uid = +document.getElementById('admin-queue-uid').value || undefined;
    try {
      await api.adminCompleteQueue(uid);
      toast('Queue completed!', 'purple');
      await loadAndRender();
    } catch (err) { toast(err.message, 'red'); }
  });

  document.getElementById('admin-grant-btn').addEventListener('click', async () => {
    const uid = +document.getElementById('admin-grant-uid').value;
    const e   = +document.getElementById('admin-grant-energy').value  || 0;
    const m   = +document.getElementById('admin-grant-matter').value  || 0;
    const c   = +document.getElementById('admin-grant-credits').value || 0;
    try {
      await api.adminGrantResources(uid, e, m, c);
      toast(`Granted E:${e} M:${m} C:${c} to user ${uid}`, 'purple');
      if (uid === 0) await loadAndRender();
    } catch (err) { toast(err.message, 'red'); }
  });

  document.getElementById('admin-set-btn').addEventListener('click', async () => {
    const uid = +document.getElementById('admin-set-uid').value;
    const e   = +document.getElementById('admin-set-energy').value  || 0;
    const m   = +document.getElementById('admin-set-matter').value  || 0;
    const c   = +document.getElementById('admin-set-credits').value || 0;
    try {
      await api.adminSetResources(uid, e, m, c);
      toast(`Set resources for user ${uid}`, 'purple');
      await loadAndRender();
    } catch (err) { toast(err.message, 'red'); }
  });

  document.getElementById('admin-add-planet-btn').addEventListener('click', async () => {
    const uid   = +document.getElementById('admin-add-uid').value;
    const type  = document.getElementById('admin-add-type').value;
    const orbit = +document.getElementById('admin-add-orbit').value;
    const level = +document.getElementById('admin-add-level').value || 1;
    try {
      await api.adminAddPlanet(uid, type, orbit, level);
      toast(`Planet added to user ${uid}`, 'purple');
      await loadAndRender();
    } catch (err) { toast(err.message, 'red'); }
  });

  document.getElementById('admin-remove-planet-btn').addEventListener('click', async () => {
    const pid = +document.getElementById('admin-remove-pid').value;
    if (!pid) { toast('Enter a planet ID', 'red'); return; }
    if (!confirm(`Delete planet ${pid}?`)) return;
    try {
      await api.adminRemovePlanet(pid);
      toast(`Planet ${pid} removed`, 'purple');
      await loadAndRender();
    } catch (err) { toast(err.message, 'red'); }
  });
}

const LOG_LEVEL_COLORS = {
  INFO:   'text-slate-300',
  WARN:   'text-yellow-400',
  ERROR:  'text-red-400',
  ACTION: 'text-indigo-400',
  ADMIN:  'text-purple-400',
};

async function loadAdminLogs() {
  const limit  = 30;
  const search = document.getElementById('admin-log-search')?.value || '';
  const level  = document.getElementById('admin-log-level')?.value  || '';
  try {
    const res = await api.adminGetLogs({ limit, offset: adminLogPage * limit, ...(search ? { search } : {}), ...(level ? { level } : {}) });
    const tbody = document.getElementById('admin-log-tbody');
    tbody.innerHTML = '';
    (res.logs || []).forEach(log => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-white/5';
      const color = LOG_LEVEL_COLORS[log.level] || 'text-slate-400';
      tr.innerHTML = `
        <td class="py-1 px-2 text-slate-500">${new Date(log.created_at).toLocaleTimeString()}</td>
        <td class="py-1 px-2 text-indigo-300">${log.username || '—'}</td>
        <td class="py-1 px-2 font-bold ${color}">${log.level}</td>
        <td class="py-1 px-2 font-mono">${log.action}</td>
        <td class="py-1 px-2 text-slate-300 max-w-xs truncate" title="${(log.detail || '').replace(/"/g,'&quot;')}">${log.detail || ''}</td>
      `;
      tbody.appendChild(tr);
    });
    document.getElementById('admin-log-count').textContent = `${res.total ?? ''} total`;
    document.getElementById('admin-log-page').textContent  = `Page ${adminLogPage + 1}`;
    document.getElementById('admin-log-prev').disabled = adminLogPage === 0;
    document.getElementById('admin-log-next').disabled = (res.logs || []).length < limit;
  } catch (err) { toast(err.message, 'red'); }
}

async function loadAdminUsers() {
  try {
    const res = await api.adminGetUsers();
    const tbody = document.getElementById('admin-users-tbody');
    tbody.innerHTML = '';
    (res.users || []).forEach(u => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-white/5';
      tr.innerHTML = `
        <td class="py-1 px-2 font-bold ${u.is_admin ? 'text-purple-300' : 'text-slate-200'}">${u.username}${u.is_admin ? ' 🛡' : ''}</td>
        <td class="py-1 px-2 text-indigo-300 truncate max-w-24">${u.system_name || '—'}</td>
        <td class="py-1 px-2 text-yellow-300">${Math.floor(u.energy ?? 0)}</td>
        <td class="py-1 px-2 text-slate-300">${Math.floor(u.matter ?? 0)}</td>
        <td class="py-1 px-2 text-amber-300">${Math.floor(u.credits ?? 0)}</td>
        <td class="py-1 px-2">${u.planet_count ?? 0}</td>
        <td class="py-1 px-2 text-slate-500">${new Date(u.created_at).toLocaleDateString()}</td>
        <td class="py-1 px-2 flex gap-1">
          <button class="btn-icon text-xs text-yellow-400" title="Reset" data-uid="${u.id}" onclick="adminResetUser(${u.id})"><i class="fa-solid fa-rotate-left"></i></button>
          <button class="btn-icon text-xs text-red-400" title="Delete" data-uid="${u.id}" onclick="adminDeleteUser(${u.id}, '${u.username}')"><i class="fa-solid fa-trash"></i></button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) { toast(err.message, 'red'); }
}

window.adminResetUser = async (uid) => {
  if (!confirm(`Reset user ${uid} to starter values?`)) return;
  try {
    await api.adminResetUser(uid);
    toast(`User ${uid} reset`, 'yellow');
    loadAdminUsers();
  } catch (err) { toast(err.message, 'red'); }
};

window.adminDeleteUser = async (uid, uname) => {
  if (!confirm(`PERMANENTLY DELETE user "${uname}" (id=${uid})?\nThis cannot be undone.`)) return;
  try {
    await api.adminDeleteUser(uid);
    toast(`User ${uname} deleted`, 'red');
    loadAdminUsers();
  } catch (err) { toast(err.message, 'red'); }
};

async function loadAdminStats() {
  try {
    const res = await api.adminGetStats();
    const grid = document.getElementById('admin-stats-grid');
    grid.innerHTML = [
      { label: 'Players',  val: res.total_users   ?? 0, icon: 'fa-user',             color: 'text-indigo-400' },
      { label: 'Planets',  val: res.total_planets ?? 0, icon: 'fa-circle-dot',        color: 'text-cyan-400'   },
      { label: 'Battles',  val: res.total_battles ?? 0, icon: 'fa-skull-crossbones',  color: 'text-red-400'    },
      { label: 'Log Lines',val: res.total_logs    ?? 0, icon: 'fa-list',              color: 'text-purple-400' },
      { label: 'Online',   val: res.online_count  ?? 0, icon: 'fa-circle text-green-400', color: 'text-green-400' },
      { label: 'Queue',    val: res.queue_pending ?? 0, icon: 'fa-clock',             color: 'text-yellow-400' },
    ].map(s => `
      <div class="glass-side rounded p-3 flex flex-col items-center gap-1">
        <i class="fa-solid ${s.icon} ${s.color} text-lg"></i>
        <span class="text-2xl font-black ${s.color}">${s.val}</span>
        <span class="text-xs text-slate-400">${s.label}</span>
      </div>
    `).join('');

    const recent = document.getElementById('admin-stats-recent');
    recent.innerHTML = (res.recent_actions || []).map(l => {
      const color = LOG_LEVEL_COLORS[l.level] || 'text-slate-400';
      return `<div class="flex gap-2 text-xs">
        <span class="text-slate-500 w-20 shrink-0">${new Date(l.created_at).toLocaleTimeString()}</span>
        <span class="font-bold ${color} w-16 shrink-0">${l.level}</span>
        <span class="text-indigo-300 w-24 shrink-0">${l.username || '—'}</span>
        <span class="text-slate-300 truncate">${l.action}: ${l.detail || ''}</span>
      </div>`;
    }).join('');
  } catch (err) { toast(err.message, 'red'); }
}

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => loadAndRender(), POLL_MS);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmt(n) {
  const v = Math.floor(n);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + 'K';
  return String(v);
}

function toast(msg, color = 'indigo') {
  const inner = document.getElementById('toast-inner');
  const colors = { indigo: '#6366f1', green: '#22c55e', red: '#ef4444', violet: '#8b5cf6', yellow: '#eab308', slate: '#64748b' };
  inner.textContent = msg;
  inner.style.borderLeft = `3px solid ${colors[color] || colors.indigo}`;
  gsap.killTweensOf(inner);
  gsap.to(inner, { opacity: 1, y: 0, duration: 0.3, ease: 'back.out(1.7)',
    onComplete: () => gsap.to(inner, { opacity: 0, y: 4, duration: 0.3, delay: 2.5 }) });
}
