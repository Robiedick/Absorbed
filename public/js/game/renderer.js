// public/js/game/renderer.js — PixiJS solar system renderer
// Expects globals: PIXI, gsap, simplex-noise loaded via vendor scripts
import { planet3d } from './planet3d.js';

export class SolarSystemRenderer {
  constructor(container, onPlanetClick, onOrbitClick) {
    this.container    = container;
    this.onPlanetClick = onPlanetClick;
    this.onOrbitClick  = onOrbitClick;
    this.app          = null;
    this.state        = null;  // { solar_system, planets }
    this.orbitAngles  = this._loadOrbitAngles();  // persisted per orbit
    this.orbitSpeeds  = [0.0006, 0.00048, 0.00038, 0.0003, 0.00024, 0.0002, 0.00016, 0.00013];
    this.planetGfx    = new Map(); // planet_id → PIXI.Sprite/Container
    this._planetLevels = new Map(); // planet_id → last built level (cache)
    this.noise        = null;
    this._noiseT      = 0;
    this._layers      = {};
    this._saveCounter = 0;
    this._world       = null;   // zoomable container (orbits + planets + star + fx)
    this._worldScale  = 1.0;
    // Pan state
    this._panOffsetX  = 0;
    this._panOffsetY  = 0;
    this._isPanning   = false;
    this._panStartX   = 0;
    this._panStartY   = 0;
    this._panOX       = 0;
    this._panOY       = 0;
    this._hasDragged  = false;
  }

  async init() {
    this.app = new PIXI.Application();
    await this.app.init({
      // Use explicit window dimensions — avoids the display:none timing bug
      // where resizeTo gets 0×0 from a hidden container.
      width:           window.innerWidth,
      height:          window.innerHeight,
      backgroundColor: 0x020409,
      antialias:       true,
      resolution:      window.devicePixelRatio || 1,
      autoDensity:     true,
    });
    // Make canvas fill its container via CSS
    this.app.canvas.style.position = 'absolute';
    this.app.canvas.style.top      = '0';
    this.app.canvas.style.left     = '0';
    this.app.canvas.style.width    = '100%';
    this.app.canvas.style.height   = '100%';
    this.container.appendChild(this.app.canvas);

    // Noise
    const { createNoise2D } = await import('/vendor/noise/esm/simplex-noise.js');
    this.noise = createNoise2D();

    // Initialise 3D planet manager (loads models from /assets/planets/)
    await planet3d.init();

    this._layers.stars   = new PIXI.Container();
    this._layers.orbits  = new PIXI.Container();
    this._layers.planets = new PIXI.Container();
    this._layers.star    = new PIXI.Container();
    this._layers.fx      = new PIXI.Container();

    // _world wraps everything except the static starfield so it can be
    // scaled as a unit for scroll-to-zoom. Pivot is locked to the system
    // centre, so zooming always targets the star.
    this._world = new PIXI.Container();
    this._world.addChild(
      this._layers.orbits,
      this._layers.planets,
      this._layers.star,
      this._layers.fx,
    );
    this.app.stage.addChild(this._layers.stars, this._world);

    this._buildStarfield();
    this._updateWorldPivot();

    // Scroll-to-zoom on the dashboard
    this.app.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this._worldScale = Math.max(0.3, Math.min(4.0, this._worldScale * factor));
      this._world.scale.set(this._worldScale);
    }, { passive: false });

    // Left-click drag to pan
    const cv = this.app.canvas;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this._isPanning  = true;
      this._hasDragged = false;
      this._panStartX  = e.clientX;
      this._panStartY  = e.clientY;
      this._panOX      = this._panOffsetX;
      this._panOY      = this._panOffsetY;
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this._isPanning) return;
      const dx = e.clientX - this._panStartX;
      const dy = e.clientY - this._panStartY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this._hasDragged = true;
      if (!this._hasDragged) return;
      this._panOffsetX = this._panOX + dx;
      this._panOffsetY = this._panOY + dy;
      this._world.position.set(this.cx + this._panOffsetX, this.cy + this._panOffsetY);
    });
    const endPan = () => { this._isPanning = false; };
    cv.addEventListener('pointerup',     endPan);
    cv.addEventListener('pointercancel', endPan);

    this.app.ticker.add(this._tick.bind(this));
    window.addEventListener('resize', () => {
      this.app.renderer.resize(window.innerWidth, window.innerHeight);
      this._buildStarfield();
      this._updateWorldPivot();
      this._repositionAll();
    });
  }

  // Visible area dimensions (accounting for left panel + top HUD)
  get _leftPanel() { return 224; }   // w-56 = 224px
  get _topHUD()    { return 56;  }   // header bar height
  get _visW()  { return this.app.screen.width  - this._leftPanel; }
  get _visH()  { return this.app.screen.height - this._topHUD; }
  // Centre of the VISIBLE area (what the player actually sees)
  get cx() { return this._leftPanel + this._visW / 2; }
  get cy() { return this._topHUD   + this._visH / 2; }
  // Max orbit radius — fill ~88% of the smaller visible dimension
  get _maxOrbitR() { return Math.min(this._visW, this._visH) * 0.44; }

  // Keep the _world pivot locked to the visible system centre so wheel-zoom
  // always scales around the star rather than the screen origin.
  _updateWorldPivot() {
    this._world.pivot.set(this.cx, this.cy);
    this._world.position.set(this.cx + this._panOffsetX, this.cy + this._panOffsetY);
  }

  // ── Orbit angle persistence ─────────────────────────────────────────────────
  _loadOrbitAngles() {
    try {
      const saved = localStorage.getItem('absorbed_orbit_angles');
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr) && arr.length === 8) return arr;
      }
    } catch { /* ignore */ }
    return Array(8).fill(0);
  }

  _persistOrbitAngles() {
    this._saveCounter++;
    if (this._saveCounter % 90 === 0) {  // ~every 1.5s at 60fps
      try {
        localStorage.setItem('absorbed_orbit_angles', JSON.stringify(this.orbitAngles));
      } catch { /* ignore */ }
    }
  }

  // ── Starfield (Simplex noise density map) ───────────────────────────────────
  _buildStarfield() {
    this._layers.stars.removeChildren();
    const g = new PIXI.Graphics();
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const COUNT = 280;
    for (let i = 0; i < COUNT; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const n = (this.noise(x * 0.003, y * 0.003) + 1) / 2;
      const r = 0.4 + n * 1.5;
      const alpha = 0.3 + n * 0.7;
      const color = [0xffffff, 0xaad4f5, 0xffd6a0, 0xc8a0f5][Math.floor(Math.random() * 4)];
      g.circle(x, y, r).fill({ color, alpha });
    }
    // Nebula patches
    for (let i = 0; i < 5; i++) {
      const nx = Math.random() * W;
      const ny = Math.random() * H;
      const nr = 60 + Math.random() * 100;
      const nc = [0x1e3a5c, 0x2d1b4e, 0x0d3d2e][Math.floor(Math.random() * 3)];
      g.circle(nx, ny, nr).fill({ color: nc, alpha: 0.12 });
    }
    this._layers.stars.addChild(g);
  }

  // Builds a PIXI Texture with a smooth radial gradient glow — pure 2D canvas,
  // perfectly smooth at any zoom level, zero pixelation.
  _makeStarGlowTexture(sizePx, starType) {
    const STOPS = {
      yellow_dwarf: ['rgba(255,240,120,0.95)', 'rgba(255,180,20,0.72)', 'rgba(255,100,0,0.38)', 'rgba(180,60,0,0.12)', 'rgba(100,30,0,0.03)', 'rgba(0,0,0,0)'],
      red_dwarf:    ['rgba(255,140,80,0.95)',  'rgba(220,60,10,0.72)',  'rgba(160,20,0,0.38)',  'rgba(100,10,0,0.12)',  'rgba(60,5,0,0.03)',   'rgba(0,0,0,0)'],
      blue_giant:   ['rgba(180,220,255,0.95)', 'rgba(80,150,255,0.72)', 'rgba(30,80,220,0.38)', 'rgba(10,40,140,0.12)', 'rgba(5,20,80,0.03)',  'rgba(0,0,0,0)'],
      white_dwarf:  ['rgba(240,240,255,0.95)', 'rgba(200,200,255,0.72)','rgba(160,160,240,0.38)','rgba(100,100,200,0.12)','rgba(60,60,150,0.03)','rgba(0,0,0,0)'],
      neutron:      ['rgba(100,255,220,0.95)', 'rgba(0,200,160,0.72)',  'rgba(0,120,100,0.38)', 'rgba(0,60,50,0.12)',   'rgba(0,30,25,0.03)',  'rgba(0,0,0,0)'],
    };
    const stops = STOPS[starType] || STOPS.yellow_dwarf;
    const c     = document.createElement('canvas');
    c.width = c.height = sizePx;
    const ctx  = c.getContext('2d');
    const half = sizePx / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    [0, 0.10, 0.28, 0.52, 0.76, 1.0].forEach((pos, i) => grad.addColorStop(pos, stops[i]));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, sizePx, sizePx);
    return PIXI.Texture.from(c);
  }

  // ── Star (centre) ────────────────────────────────────────────────────────────
  _buildStar(starType, level) {
    planet3d.registerStar();  // idempotent — no-op if already registered
    this._layers.star.removeChildren();

    const baseR = Math.max(32, this._maxOrbitR * 0.10) + level * 3;
    const tex   = planet3d.getStarTexture();

    // Radial gradient glow — drawn on a 2D canvas so it's perfectly smooth at any zoom
    const glowTex    = this._makeStarGlowTexture(1024, starType);
    const glowSprite = new PIXI.Sprite(glowTex);
    glowSprite.width = glowSprite.height = baseR * 7.5;
    glowSprite.anchor.set(0.5);
    this._layers.star.addChild(glowSprite);

    if (tex) {
      // Crisp 3D body on top
      const body = new PIXI.Sprite(tex);
      body.width = body.height = baseR * 2.4;
      body.anchor.set(0.5);
      const cm = new PIXI.ColorMatrixFilter();
      cm.brightness(2.0, false);
      body.filters = [cm];
      this._layers.star.addChild(body);
    } else {
      // 2D fallback
      const FLAT = {
        yellow_dwarf: { core: 0xFFE066 },
        red_dwarf:    { core: 0xFF5533 },
        blue_giant:   { core: 0x88CCFF },
        white_dwarf:  { core: 0xEEEEFF },
        neutron:      { core: 0x00FFEE },
      };
      const core = new PIXI.Graphics();
      core.circle(0, 0, baseR).fill({ color: (FLAT[starType] || FLAT.yellow_dwarf).core });
      this._layers.star.addChild(core);
    }

    this._layers.star.x = this.cx;
    this._layers.star.y = this.cy;
    this._layers.star.scale.set(1);
    gsap.to(this._layers.star.scale, {
      x: 1.06, y: 1.06, duration: 2.2 + Math.random(),
      repeat: -1, yoyo: true, ease: 'sine.inOut',
    });
  }

  // ── Orbit rings ──────────────────────────────────────────────────────────────
  _buildOrbits(occupiedSlots) {
    this._layers.orbits.removeChildren();
    const g = new PIXI.Graphics();
    for (let i = 0; i < 8; i++) {
      const r = this._orbitRadius(i);
      const occupied = occupiedSlots.includes(i);
      g.circle(this.cx, this.cy, r)
       .stroke({ color: occupied ? 0x3344aa : 0x222244, width: 1, alpha: occupied ? 0.5 : 0.25 });
    }
    this._layers.orbits.addChild(g);

    // Clickable "add planet" markers on empty orbits
    for (let i = 0; i < 8; i++) {
      if (!occupiedSlots.includes(i)) {
        const r   = this._orbitRadius(i);
        const ang = -Math.PI / 2;
        const mx  = this.cx + Math.cos(ang) * r;
        const my  = this.cy + Math.sin(ang) * r;

        const marker = new PIXI.Graphics();
        marker.circle(0, 0, 7).fill({ color: 0x334466, alpha: 0.7 });
        marker.circle(0, 0, 7).stroke({ color: 0x5566aa, width: 1 });
        // + sign
        marker.rect(-2.5, -0.5, 5, 1).fill({ color: 0x8899cc });
        marker.rect(-0.5, -2.5, 1, 5).fill({ color: 0x8899cc });
        marker.x = mx;
        marker.y = my;
        marker.eventMode = 'static';
        marker.cursor   = 'pointer';
        marker.on('pointerover',  () => gsap.to(marker.scale, { x: 1.4, y: 1.4, duration: 0.2 }));
        marker.on('pointerout',   () => gsap.to(marker.scale, { x: 1,   y: 1,   duration: 0.2 }));
        marker.on('pointertap',   () => this.onOrbitClick(i));
        this._layers.orbits.addChild(marker);
      }
    }
  }

  _orbitRadius(index) {
    const innerR  = this._maxOrbitR * 0.22;  // innermost orbit — keep clear of the star
    const spacing = (this._maxOrbitR - innerR) / 7;
    return innerR + index * spacing;
  }

  // ── Planet ───────────────────────────────────────────────────────────────────
  static PLANET_COLORS = {
    rocky:    { base: 0x8B7355, spot: 0x6B5335, glow: 0xAA9977 },
    gas:      { base: 0xE8A87C, spot: 0xCC7744, glow: 0xFFCC99 },
    ocean:    { base: 0x1E6BA8, spot: 0x0A4477, glow: 0x44AAFF },
    ice:      { base: 0xADD8E6, spot: 0x88BBCC, glow: 0xDDEEFF },
    volcanic: { base: 0xCC3300, spot: 0xFF6600, glow: 0xFF4400 },
    crystal:  { base: 0x9370DB, spot: 0x6644BB, glow: 0xCC99FF },
  };

  _buildPlanet(planet) {
    // Skip rebuild unless new, levelled up, OR was a 2D fallback that now has a 3D texture
    if (this.planetGfx.has(planet.id) && this._planetLevels.get(planet.id) === planet.level) {
      const existing = this.planetGfx.get(planet.id);
      if (!existing._is2dFallback || !planet3d.getTexture(planet.id)) return; // nothing to upgrade
      // fall through to replace 2D fallback with 3D sprite
    }

    const existing = this.planetGfx.get(planet.id);
    if (existing) this._layers.planets.removeChild(existing);
    this._planetLevels.set(planet.id, planet.level);

    // Ensure registered with the 3D engine (no-op if already done)
    planet3d.registerPlanet(planet);
    const tex = planet3d.getTexture(planet.id);

    if (tex) {
      // ── 3D path – texture is a live canvas that Three.js updates each frame ──
      const sizeScale = planet.size_scale != null ? Number(planet.size_scale) : 1.0;
      // Cap size so even large sizeScale planets stay within orbit ring spacing
      const size      = Math.min(72, Math.max(20, (9 + planet.level * 2.2) * 2.4 * sizeScale));

      const wrap = new PIXI.Container();
      const sprite = new PIXI.Sprite(tex);
      sprite.width = sprite.height = size;
      sprite.anchor.set(0.5);
      wrap.addChild(sprite);

      // Level badge
      if (planet.level > 1) {
        const badge = new PIXI.Graphics();
        badge.circle(size / 2 - 5, -size / 2 + 5, 7).fill({ color: 0x111133, alpha: 0.9 });
        badge.circle(size / 2 - 5, -size / 2 + 5, 7).stroke({ color: 0x8888ff, width: 1 });
        const lbl = new PIXI.Text({ text: String(planet.level), style: { fontSize: 8, fill: 0xffffff, fontWeight: 'bold' } });
        lbl.anchor.set(0.5); lbl.x = size / 2 - 5; lbl.y = -size / 2 + 5;
        wrap.addChild(badge, lbl);
      }

      // Moon count dots (shown beneath the planet)
      const moonCount = planet.moon_count || 0;
      for (let m = 0; m < moonCount && m < 3; m++) {
        const dot = new PIXI.Graphics();
        dot.circle(0, 0, 2.5).fill({ color: 0xaaaacc, alpha: 0.8 });
        dot.x = (m - (moonCount - 1) / 2) * 7;
        dot.y = size / 2 + 6;
        wrap.addChild(dot);
      }

      wrap.eventMode = 'static'; wrap.cursor = 'pointer';
      // Explicit hit area large enough to include the level badge, moon dots,
      // and the 1.2× hover-scale without anything getting clipped.
      const pad = size * 0.8;
      wrap.hitArea = new PIXI.Rectangle(-size / 2 - pad, -size / 2 - pad, size + pad * 2, size + pad * 2 + 16);
      wrap.on('pointerover', () => gsap.to(wrap.scale, { x: 1.2, y: 1.2, duration: 0.2 }));
      wrap.on('pointerout',  () => gsap.to(wrap.scale, { x: 1,   y: 1,   duration: 0.2 }));
      wrap.on('pointertap',  () => this.onPlanetClick(planet));
      this._layers.planets.addChild(wrap);
      this.planetGfx.set(planet.id, wrap);
      return;
    }

    // ── 2D fallback (WebGL completely unavailable) ───────────────────────────
    const c = SolarSystemRenderer.PLANET_COLORS[planet.type] || SolarSystemRenderer.PLANET_COLORS.rocky;
    const r   = 9 + planet.level * 2.2;
    const ctr = new PIXI.Container();
    const halo = new PIXI.Graphics();
    halo.circle(0, 0, r + 4).fill({ color: c.glow, alpha: 0.2 });
    ctr.addChild(halo);
    const body = new PIXI.Graphics();
    body.circle(0, 0, r).fill({ color: c.base });
    ctr.addChild(body);
    const hl = new PIXI.Graphics();
    hl.circle(-r * 0.28, -r * 0.28, r * 0.28).fill({ color: 0xFFFFFF, alpha: 0.3 });
    ctr.addChild(hl);
    if (planet.level > 1) {
      const badge = new PIXI.Graphics();
      badge.circle(r - 2, -r + 2, 6).fill({ color: 0x222244 });
      badge.circle(r - 2, -r + 2, 6).stroke({ color: c.glow, width: 1 });
      ctr.addChild(badge);
      const label = new PIXI.Text({ text: String(planet.level), style: { fontSize: 7, fill: 0xffffff, fontWeight: 'bold' } });
      label.anchor.set(0.5); label.x = r - 2; label.y = -r + 2;
      ctr.addChild(label);
    }
    ctr.eventMode = 'static'; ctr.cursor = 'pointer';
    ctr.on('pointerover', () => { gsap.to(ctr.scale, { x: 1.25, y: 1.25, duration: 0.2 }); gsap.to(halo, { alpha: 0.55, duration: 0.2 }); });
    ctr.on('pointerout',  () => { gsap.to(ctr.scale, { x: 1,    y: 1,    duration: 0.2 }); gsap.to(halo, { alpha: 0.20, duration: 0.2 }); });
    ctr.on('pointertap',  () => this.onPlanetClick(planet));
    ctr._is2dFallback = true;
    this._layers.planets.addChild(ctr);
    this.planetGfx.set(planet.id, ctr);
  }

  // Per-planet orbital speed uses the DB-stored multiplier (planet.orbital_speed)
  // so every planet orbits at its own unique pace.
  _tick(ticker) {
    if (!this.state) return;
    this._noiseT += 0.002;

    // Advance 3D planet model rotations + moon orbits
    planet3d.tick(ticker.deltaTime);

    const planets = this.state.planets;
    for (const p of planets) {
      const speedMult = (p.orbital_speed != null ? Number(p.orbital_speed) : 1.0);
      this.orbitAngles[p.orbit_index] += this.orbitSpeeds[p.orbit_index] * speedMult * ticker.deltaTime;
      const r   = this._orbitRadius(p.orbit_index);
      const ang = this.orbitAngles[p.orbit_index];
      const ctr = this.planetGfx.get(p.id);
      if (ctr) {
        ctr.x = this.cx + Math.cos(ang) * r;
        ctr.y = this.cy + Math.sin(ang) * r;
      }
    }

    // Star corona pulse
    if (this._layers.star) {
      const n = (this.noise(this._noiseT, 0) + 1) / 2;
      this._layers.star.scale.set(1 + n * 0.04);
    }

    this._persistOrbitAngles();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  render(state) {
    this.state = state;
    const { solar_system, planets } = state;
    const occupied = planets.map(p => p.orbit_index);

    this._buildStar(solar_system.star_type, solar_system.star_level);
    this._buildOrbits(occupied);

    // Remove planets no longer present
    for (const [id, ctr] of this.planetGfx) {
      if (!planets.find(p => p.id === id)) {
        this._layers.planets.removeChild(ctr);
        this.planetGfx.delete(id);
      }
    }

    // Add new / updated planets
    for (const p of planets) {
      this._buildPlanet(p);
      // Set initial position
      const r   = this._orbitRadius(p.orbit_index);
      const ang = this.orbitAngles[p.orbit_index];
      const ctr = this.planetGfx.get(p.id);
      if (ctr) { ctr.x = this.cx + Math.cos(ang) * r; ctr.y = this.cy + Math.sin(ang) * r; }
    }
  }

  _repositionAll() {
    if (this._layers.star) { this._layers.star.x = this.cx; this._layers.star.y = this.cy; }
    if (this.state) this.render(this.state);
  }

  // Battle flash effect (red overlay pulse)
  flashBattle() {
    const flash = new PIXI.Graphics();
    flash.rect(0, 0, this.app.screen.width, this.app.screen.height).fill({ color: 0xff0000, alpha: 0.18 });
    this._layers.fx.addChild(flash);
    gsap.to(flash, { alpha: 0, duration: 0.8, onComplete: () => this._layers.fx.removeChild(flash) });
  }

  // Explosion at a specific planet's current screen position, then calls onDone.
  spawnPlanetExplosion(planetId, onDone) {
    const ctr = this.planetGfx.get(planetId);
    // _layers.fx lives inside _world, so use world-local coords for PixiJS particles
    const x   = ctr ? ctr.x : this.cx;
    const y   = ctr ? ctr.y : this.cy;
    // CSS screen coords for the Three.js GLB overlay
    const screenX = (x - this.cx) * this._worldScale + this.cx;
    const screenY = (y - this.cy) * this._worldScale + this.cy;
    planet3d.spawnExplosionAt(screenX, screenY);

    // Fade + scale-up the planet sprite so it looks like it's blowing apart
    if (ctr) {
      gsap.to(ctr.scale, { x: 2.0, y: 2.0, duration: 0.25, ease: 'power2.out' });
      gsap.to(ctr,       { alpha: 0,        duration: 0.35, ease: 'power2.in'  });
    }

    // Central flash
    const flash = new PIXI.Graphics();
    flash.circle(x, y, 70).fill({ color: 0xFF8800, alpha: 0.7 });
    this._layers.fx.addChild(flash);
    gsap.to(flash, { alpha: 0, duration: 0.6, onComplete: () => this._layers.fx.removeChild(flash) });

    // Particle burst
    const COLORS = [0xFF2200, 0xFF6600, 0xFFAA00, 0xFFEE44, 0xFF4400];
    for (let i = 0; i < 48; i++) {
      const p   = new PIXI.Graphics();
      const r   = 2.5 + Math.random() * 7;
      p.circle(0, 0, r).fill({ color: COLORS[Math.floor(Math.random() * COLORS.length)], alpha: 1 });
      p.x = x; p.y = y;
      this._layers.fx.addChild(p);
      const ang  = Math.random() * Math.PI * 2;
      const dist = 50 + Math.random() * 180;
      gsap.to(p, {
        x: x + Math.cos(ang) * dist,
        y: y + Math.sin(ang) * dist,
        alpha: 0,
        duration: 0.6 + Math.random() * 0.7,
        ease:     'power2.out',
        onComplete: () => this._layers.fx.removeChild(p),
      });
    }

    // Smoke / debris trail (darker, slower)
    for (let i = 0; i < 16; i++) {
      const p   = new PIXI.Graphics();
      p.circle(0, 0, 4 + Math.random() * 6).fill({ color: 0x443311, alpha: 0.7 });
      p.x = x; p.y = y;
      this._layers.fx.addChild(p);
      const ang  = Math.random() * Math.PI * 2;
      const dist = 20 + Math.random() * 80;
      gsap.to(p, {
        x: x + Math.cos(ang) * dist,
        y: y + Math.sin(ang) * dist,
        alpha: 0,
        duration: 1.0 + Math.random() * 0.8,
        delay:    0.1 + Math.random() * 0.2,
        ease:     'power1.out',
        onComplete: () => this._layers.fx.removeChild(p),
      });
    }

    setTimeout(() => onDone?.(), 900);
  }

  // Explosion particle burst at screen centre
  spawnBurst(color = 0xFFAA00) {
    for (let i = 0; i < 24; i++) {
      const p   = new PIXI.Graphics();
      const r   = 2 + Math.random() * 4;
      p.circle(0, 0, r).fill({ color, alpha: 1 });
      p.x = this.cx;
      p.y = this.cy;
      this._layers.fx.addChild(p);
      const ang  = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 120;
      gsap.to(p, {
        x: this.cx + Math.cos(ang) * dist,
        y: this.cy + Math.sin(ang) * dist,
        alpha: 0,
        duration: 0.8 + Math.random() * 0.4,
        ease: 'power2.out',
        onComplete: () => this._layers.fx.removeChild(p),
      });
    }
  }
}
