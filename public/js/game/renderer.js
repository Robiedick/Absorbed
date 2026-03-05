// public/js/game/renderer.js — PixiJS solar system renderer
// Expects globals: PIXI, gsap, simplex-noise loaded via vendor scripts
import { planet3d } from './planet3d.js';
import { api }       from './api.js';

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
    // Trade ships
    this._ships          = [];
    this._livePlanets    = [];
    this._shipIdCounter  = 0;
    // Combat
    this._projectiles    = [];   // { x,y,vx,vy,ownerId,targetShip,damage,life,maxLife,hit }
    this._lasers         = [];   // { x1,y1,x2,y2,life,maxLife,color }
    this._combatGfx      = null; // single Graphics cleared/redrawn each tick
    // Star spikes
    this._starBaseR      = 30;
    this._starSpikeGfx   = null;
    this._starSpikeColor = 0xffdd44;
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
    this._layers.ships   = new PIXI.Container();   // trade ships (above orbits, below planets)
    this._layers.planets = new PIXI.Container();
    this._layers.star    = new PIXI.Container();
    this._layers.fx      = new PIXI.Container();
    this._combatGfx = new PIXI.Graphics();
    this._layers.ships.addChild(this._combatGfx);

    // _world wraps everything except the static starfield so it can be
    // scaled as a unit for scroll-to-zoom. Pivot is locked to the system
    // centre, so zooming always targets the star.
    this._world = new PIXI.Container();
    this._world.addChild(
      this._layers.orbits,
      this._layers.ships,
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
      this._worldScale = Math.max(0.3, Math.min(8.0, this._worldScale * factor));
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
      // ── Middle-mouse rotate ─────────────────────────────────────────────
      if (this._isRotating) {
        const dx = e.clientX - this._rotStartX;
        const dy = e.clientY - this._rotStartY;
        this._world.rotation = this._rotStartAngle + dx * 0.005;
        // Allow vertical drag to tilt the whole system (simple Y offset)
        this._world.skew.y = Math.max(-0.4, Math.min(0.4, (this._rotStartSkewY || 0) + dy * 0.003));
        return;
      }
      // ── Left-drag pan ─────────────────────────────────────────────────
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
    const endRotate = () => { this._isRotating = false; };
    cv.addEventListener('pointerup',     (e) => { if (e.button === 1) endRotate(); else endPan(); });
    cv.addEventListener('pointercancel', () => { endPan(); endRotate(); });

    // Middle-mouse drag to rotate the system
    this._isRotating   = false;
    this._rotStartX    = 0;
    this._rotStartY    = 0;
    this._rotStartAngle = 0;
    this._rotStartSkewY = 0;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this._isRotating    = true;
      this._rotStartX     = e.clientX;
      this._rotStartY     = e.clientY;
      this._rotStartAngle = this._world.rotation;
      this._rotStartSkewY = this._world.skew.y || 0;
    });

    // ── Pinch-to-zoom (two-finger touch) ───────────────────────────────────
    let _pinchStartDist  = null;
    let _pinchStartScale = 1;
    let _pinchMidX = 0, _pinchMidY = 0;  // midpoint of the two fingers
    cv.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        this._isPanning = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        _pinchStartDist  = Math.hypot(dx, dy);
        _pinchStartScale = this._worldScale;
        _pinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        _pinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      }
    }, { passive: false });
    cv.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && _pinchStartDist !== null) {
        e.preventDefault();
        const dx   = e.touches[0].clientX - e.touches[1].clientX;
        const dy   = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const factor   = dist / _pinchStartDist;
        this._worldScale = Math.max(0.25, Math.min(10.0, _pinchStartScale * factor));
        this._world.scale.set(this._worldScale);
      }
    }, { passive: false });
    cv.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) _pinchStartDist = null;
    }, { passive: true });

    this.app.ticker.add(this._tick.bind(this));
    window.addEventListener('resize', () => {
      this.app.renderer.resize(window.innerWidth, window.innerHeight);
      this._buildStarfield();
      this._updateWorldPivot();
      this._repositionAll();
    });
  }

  // Visible area dimensions (accounting for left panel + top HUD)
  get _leftPanel() { return window.innerWidth >= 768 ? 224 : 0; }  // 0 on mobile (sheet)
  get _topHUD()    { return 56;  }   // header bar height
  get _bottomNav() { return window.innerWidth < 768 ? 64 : 0; }    // mobile bottom nav
  get _visW()  { return this.app.screen.width  - this._leftPanel; }
  get _visH()  { return this.app.screen.height - this._topHUD - this._bottomNav; }
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
    planet3d.registerStar();
    this._layers.star.removeChildren();
    gsap.killTweensOf(this._layers.star.scale);

    const baseR = Math.max(32, this._maxOrbitR * 0.10) + level * 3;
    this._starBaseR = baseR;
    this._starSpikeGfx = null;  // will be re-assigned below
    const SPIKE_COLORS = { yellow_dwarf: 0xffdd44, red_dwarf: 0xff6622, blue_giant: 0x88ccff, white_dwarf: 0xeeeeff, neutron: 0x00ffcc };
    this._starSpikeColor = SPIKE_COLORS[starType] ?? 0xffdd44;

    const tex = planet3d.getStarTexture();

    // Wide radial glow (14× baseR so it bleeds across the whole viewport)
    const glowTex    = this._makeStarGlowTexture(1024, starType);
    const glowSprite = new PIXI.Sprite(glowTex);
    glowSprite.width = glowSprite.height = baseR * 14;
    glowSprite.anchor.set(0.5);
    this._layers.star.addChild(glowSprite);

    // Solar spike graphics — sits between glow and 3D body
    this._starSpikeGfx = new PIXI.Graphics();
    this._layers.star.addChild(this._starSpikeGfx);

    if (tex) {
      const body = new PIXI.Sprite(tex);
      body.width = body.height = baseR * 2.4;
      body.anchor.set(0.5);
      const cm = new PIXI.ColorMatrixFilter();
      cm.brightness(2.8, false);
      body.filters = [cm];
      this._layers.star.addChild(body);
    } else {
      const FLAT = {
        yellow_dwarf: { core: 0xFFE066 }, red_dwarf: { core: 0xFF5533 },
        blue_giant:   { core: 0x88CCFF }, white_dwarf: { core: 0xEEEEFF }, neutron: { core: 0x00FFEE },
      };
      const core = new PIXI.Graphics();
      core.circle(0, 0, baseR).fill({ color: (FLAT[starType] || FLAT.yellow_dwarf).core });
      this._layers.star.addChild(core);
    }

    this._layers.star.x = this.cx;
    this._layers.star.y = this.cy;
    this._layers.star.scale.set(1);
    gsap.to(this._layers.star.scale, {
      x: 1.08, y: 1.08, duration: 2.0 + Math.random() * 0.8,
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
      // sizeScale range is 0.4–2.0, base formula doubled from original for bolder presence
      const size = Math.min(290, Math.max(48, (9 + planet.level * 2.2) * 4.8 * sizeScale));

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
      // Hit area is just slightly larger than the visible planet sprite
      const pad = size * 0.12;
      wrap.hitArea = new PIXI.Rectangle(-size / 2 - pad, -size / 2 - pad, size + pad * 2, size + pad * 2 + 16);
      wrap.on('pointerover', () => gsap.to(wrap.scale, { x: 1.2, y: 1.2, duration: 0.2 }));
      wrap.on('pointerout',  () => gsap.to(wrap.scale, { x: 1,   y: 1,   duration: 0.2 }));
      wrap.on('pointertap',  () => { if (!this._hasDragged) this.onPlanetClick(planet); });
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
    ctr.on('pointertap',  () => { if (!this._hasDragged) this.onPlanetClick(planet); });
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

    // Tick trade ships
    this._tickShips(ticker.deltaTime);

    // Star corona pulse + soft solar flares
    if (this._layers.star) {
      const n = (this.noise(this._noiseT, 0) + 1) / 2;
      this._layers.star.scale.set(1 + n * 0.05);
      if (this._starSpikeGfx && this._starBaseR) {
        const g  = this._starSpikeGfx;
        const br = this._starBaseR;
        g.clear();
        // 8 soft flares: each is a fan of ~10 hairlines at jittered angles,
        // full-bright near the surface and fading to transparent over their length.
        const NUM = 8;
        for (let i = 0; i < NUM; i++) {
          const ni   = (this.noise(this._noiseT * 0.9 + i * 0.7, 0.3) + 1) * 0.5;
          const base = (i / NUM) * Math.PI * 2;
          const len  = br * (1.4 + ni * 3.2);  // 1.4–4.6× star radius
          const LINES = 10;
          const spread = 0.055;  // narrow angular fan
          for (let k = 0; k < LINES; k++) {
            const kRatio = k / (LINES - 1);       // 0..1 across fan
            const ang = base + (kRatio - 0.5) * spread * 2;
            const edgeFade = 1 - Math.abs(kRatio - 0.5) * 2; // 0 at edges, 1 at centre
            // draw several overlapping segments with decreasing alpha
            for (let seg = 0; seg < 6; seg++) {
              const s0 = seg / 6, s1 = (seg + 1) / 6;
              const segAlpha = edgeFade * ni * (1 - s0) * (1 - s0) * 0.18;
              if (segAlpha < 0.004) continue;
              g.moveTo(Math.cos(ang) * (br + s0 * len), Math.sin(ang) * (br + s0 * len));
              g.lineTo(Math.cos(ang) * (br + s1 * len), Math.sin(ang) * (br + s1 * len));
              g.stroke({ color: this._starSpikeColor, width: (1 - s0) * 1.2, alpha: segAlpha });
            }
          }
        }
      }
    }

    this._persistOrbitAngles();
  }

  // ── Trade ship management ────────────────────────────────────────────────────
  // SHIP_MODELS must live in /public/assets/ships/
  static SHIP_MODELS = ['Trade_Ship_1.glb', 'Trade_Ship_2.glb', 'Trade_Ship_3.glb'];

  // Called by app.js whenever the trade center count changes.
  setTradeShipCount(count, planets) {
    this._livePlanets = (planets || []).filter(p => p); // store fresh planet list

    // Remove excess ships
    while (this._ships.length > count) {
      const s = this._ships.pop();
      // Clear partner combat reference
      if (s.combatTarget) { s.combatTarget.isFighting = false; s.combatTarget.combatTarget = null; }
      if (s.sprite)    this._layers.ships.removeChild(s.sprite);
      if (s.trailGfx)  this._layers.ships.removeChild(s.trailGfx);
      if (s.flameGfx)  this._layers.ships.removeChild(s.flameGfx);
      planet3d.unregisterShip(s.shipId);
    }

    // Spawn missing ships (only if we have ≥ 2 planets to fly between)
    while (this._ships.length < count && this._livePlanets.length >= 2) {
      this._spawnShip();
    }
  }

  // Rotation offset: the rendered image has the ship nose pointing toward -Z in world
  // which, from a top-down camera with up=(0,0,-1), appears at the TOP of the canvas.
  // In PixiJS, rotation=0 means facing right (+X). Top-of-canvas = -PI/2 in PixiJS.
  // So we subtract PI/2 from the travel angle so the nose aligns with motion.
  static SHIP_ROT_OFFSET = -Math.PI / 2;

  _spawnShip() {
    if (this._livePlanets.length < 2) return;

    const model   = SolarSystemRenderer.SHIP_MODELS[
      Math.floor(Math.random() * SolarSystemRenderer.SHIP_MODELS.length)
    ];
    const shipId  = this._shipIdCounter++;

    // Pick random from/to (must be different planets)
    const fromIdx  = Math.floor(Math.random() * this._livePlanets.length);
    const toOffset = 1 + Math.floor(Math.random() * (this._livePlanets.length - 1));
    const toIdx    = (fromIdx + toOffset) % this._livePlanets.length;

    // Trail drawn directly in ship layer
    const trailGfx = new PIXI.Graphics();
    this._layers.ships.addChild(trailGfx);

    // Flame / exhaust overlay (drawn BEHIND sprite each frame)
    const flameGfx = new PIXI.Graphics();
    this._layers.ships.addChild(flameGfx);

    // Register ship with planet3d — returns live texture immediately (blank until model loads)
    const liveTex = planet3d.registerShip(shipId, model);
    const sprite  = new PIXI.Sprite(liveTex || PIXI.Texture.WHITE);
    // 3px — half of previous 6px.  Set once; NEVER call sprite.scale.set() in tick.
    sprite.width  = sprite.height = 3;
    sprite.anchor.set(0.5);
    sprite.alpha  = 0;                    // fade in once underway
    this._layers.ships.addChild(sprite);

    const ship = {
      shipId,
      sprite,
      trailGfx,
      flameGfx,
      model,
      fromPlanet:  this._livePlanets[fromIdx],
      toPlanet:    this._livePlanets[toIdx],
      progress:    Math.random(),
      speed:       0.055 + Math.random() * 0.035,
      arcSign:     Math.random() < 0.5 ? 1 : -1,
      arcFactor:   0.30 + Math.random() * 0.28,
      trailPoints: [],
      dwell:       0,
      prevAngle:   0,
      barrelTimer: 5 + Math.random() * 13,
      stuntTimer:  4 + Math.random() * 10,
      stunType:    null, stunPhase: 0, stunDur: 0,
      // Combat
      hp: 3, maxHp: 3,              // 3 hits to kill
      bounty:           0,          // kills scored; >= 3 makes other ships avoid/gang-up
      combatTarget:     null,
      isFighting:       false,
      fireCooldown:     1.0,
      combatPrevAngle:  0,
      noBonusOnArrival: false,
      // Steering AI (Craig Reynolds)
      cvx: 0, cvy: 0,               // continuous combat velocity
      combatState:      'ATTACK',    // ATTACK | STRAFE | RETREAT
      combatStateTimer: 1.5 + Math.random() * 2,
    };
    this._ships.push(ship);
  }

  // Shared helper — puts one ship into combat against a target
  _engageShip(ship, target, isAggressor) {
    ship.isFighting      = true;
    ship.combatTarget    = target;
    ship.hp              = ship.maxHp;   // reset to full so every fight is a clean 3-hit
    ship.cvx = 0;  ship.cvy = 0;
    if (isAggressor) {
      ship.combatState      = 'ATTACK';
      ship.combatStateTimer = 0.5 + Math.random() * 0.8;
      ship.fireCooldown     = 0.15 + Math.random() * 0.25;  // attacker fires first
    } else {
      ship.combatState      = 'STRAFE';
      ship.combatStateTimer = 0.6 + Math.random() * 0.8;
      ship.fireCooldown     = 1.0  + Math.random() * 0.7;   // defender reacts slower
    }
  }

  _tickShips(deltaTime) {
    if (!this._ships.length) return;
    const dt = deltaTime / 60;

    // ── Combat proximity check ─────────────────────────────────────────────────
    const COMBAT_DIST = 65 / this._worldScale;
    const ALLY_RANGE  = 110 / this._worldScale;  // radius to search for a gang-up partner
    for (let i = 0; i < this._ships.length; i++) {
      for (let j = i + 1; j < this._ships.length; j++) {
        const a = this._ships[i], b = this._ships[j];
        if (a.dwell > 0 || b.dwell > 0) continue;
        const cdx = a.sprite.x - b.sprite.x, cdy = a.sprite.y - b.sprite.y;
        const cdist = Math.hypot(cdx, cdy);
        if (cdist < COMBAT_DIST && !a.isFighting && !b.isFighting) {
          // ── Bounty avoidance / gang-up ────────────────────────────────────
          const aBounty = a.bounty >= 3, bBounty = b.bounty >= 3;
          if (aBounty || bBounty) {
            const wanted   = aBounty ? a : b;
            const civilian = aBounty ? b : a;
            const ally = this._ships.find(s =>
              s !== wanted && s !== civilian && s.dwell <= 0 && !s.isFighting &&
              Math.hypot(s.sprite.x - civilian.sprite.x, s.sprite.y - civilian.sprite.y) < ALLY_RANGE
            );
            if (ally) {
              this._engageShip(civilian, wanted, true);
              this._engageShip(ally,     wanted, true);
              const closerAttacker =
                Math.hypot(civilian.sprite.x - wanted.sprite.x, civilian.sprite.y - wanted.sprite.y) <
                Math.hypot(ally.sprite.x     - wanted.sprite.x, ally.sprite.y     - wanted.sprite.y)
                ? civilian : ally;
              this._engageShip(wanted, closerAttacker, false);
            }
            // else: no ally nearby — civilian avoids the wanted ship
            continue;
          }

          // ── Normal encounter: each ship has 20 % independent chance to attack ──
          const aAttacks = Math.random() < 0.20;
          const bAttacks = Math.random() < 0.20;
          if (!aAttacks && !bAttacks) continue;   // ~64 % peaceful pass

          if (aAttacks && bAttacks) {
            this._engageShip(a, b, true);
            this._engageShip(b, a, true);
          } else if (aAttacks) {
            this._engageShip(a, b, true);
            this._engageShip(b, a, false);
          } else {
            this._engageShip(b, a, true);
            this._engageShip(a, b, false);
          }
        }
        if (cdist > COMBAT_DIST * 2.8 && a.combatTarget === b) {
          a.isFighting = false; b.isFighting = false;
          a.combatTarget = null; b.combatTarget = null;
        }
      }
    }

    for (const ship of this._ships) {
      // ── Dwell (landed / respawning) ──────────────────────────────────────────
      if (ship.dwell > 0) {
        ship.dwell -= dt;
        if (ship.dwell <= 0) { ship.sprite.alpha = 0; ship.flameGfx.clear(); }
        continue;
      }

      // ── Combat flight (steering-behaviour AI) ──────────────────────────────
      if (ship.isFighting && ship.combatTarget && ship.combatTarget.dwell <= 0) {
        const tgt       = ship.combatTarget;
        const MAX_SPD   = 75 / this._worldScale;
        const MAX_ACC   = 210 / this._worldScale;
        const PROJ_SPD  = 200 / this._worldScale;

        // ── State machine transition ───────────────────────────────────────
        ship.combatStateTimer -= dt;
        if (ship.combatStateTimer <= 0) {
          const hpR = ship.hp / ship.maxHp;
          // Tuned for 3-HP system: 1/3≈17% → retreat, 2/3≈67% → strafe, 3/3 → attack
          if (hpR < 0.40) {
            ship.combatState = 'RETREAT';
            ship.combatStateTimer = 1.0 + Math.random() * 1.2;
          } else if (hpR < 0.75) {
            ship.combatState = Math.random() < 0.50 ? 'STRAFE' : 'ATTACK';
            ship.combatStateTimer = 0.8 + Math.random() * 1.0;
          } else {
            ship.combatState = Math.random() < 0.65 ? 'ATTACK' : 'STRAFE';
            ship.combatStateTimer = 1.2 + Math.random() * 1.8;
          }
        }

        // ── Target prediction: lead based on flight time ───────────────────
        const toDist  = Math.hypot(ship.sprite.x - tgt.sprite.x, ship.sprite.y - tgt.sprite.y) || 1;
        const leadT   = Math.min(0.8, toDist / (PROJ_SPD || 1));
        const predTx  = tgt.sprite.x + (tgt.cvx || 0) * leadT;
        const predTy  = tgt.sprite.y + (tgt.cvy || 0) * leadT;

        // ── Compute desired velocity per state ─────────────────────────────
        const rx = ship.sprite.x - tgt.sprite.x;  // radial vector (ship → away from tgt)
        const ry = ship.sprite.y - tgt.sprite.y;
        const dist = Math.hypot(rx, ry) || 1;
        const tx = -ry / dist, ty = rx / dist;  // tangent (perpendicular CCW)

        let desX = 0, desY = 0;
        if (ship.combatState === 'ATTACK') {
          // Seek predicted position — charges directly at where target will be
          const pdx = predTx - ship.sprite.x, pdy = predTy - ship.sprite.y;
          const pl  = Math.hypot(pdx, pdy) || 1;
          desX = pdx / pl * MAX_SPD;
          desY = pdy / pl * MAX_SPD;
        } else if (ship.combatState === 'STRAFE') {
          // Orbit at oscillating radius: circle + radial correction
          const IDEAL = (28 + Math.sin(Date.now() * 0.0009 + ship.shipId * 1.7) * 10) / this._worldScale;
          const radMag = (dist - IDEAL) / IDEAL;
          desX = tx * MAX_SPD - rx / dist * radMag * MAX_SPD * 0.5;
          desY = ty * MAX_SPD - ry / dist * radMag * MAX_SPD * 0.5;
        } else {  // RETREAT
          // Flee + random jink so it's not a straight line
          const jink = Math.sin(Date.now() * 0.0025 + ship.shipId * 2.3) * 0.4;
          desX = (rx / dist + tx * jink) * MAX_SPD;
          desY = (ry / dist + ty * jink) * MAX_SPD;
        }

        // ── Projectile proximity dodge ─────────────────────────────────────
        const DODGE_R = 20 / this._worldScale;
        for (const p of this._projectiles) {
          if (p.ownerId === ship.shipId) continue;
          const pdx = p.x - ship.sprite.x, pdy = p.y - ship.sprite.y;
          const pd  = Math.hypot(pdx, pdy);
          if (pd < DODGE_R && pd > 0.01) {
            const influence = (1 - pd / DODGE_R) * 2.0;
            desX += -pdy / pd * influence * MAX_SPD;
            desY +=  pdx / pd * influence * MAX_SPD;
          }
        }

        // ── Apply steering force (blended into continuous velocity) ────────
        const steerX = desX - ship.cvx;  const steerY = desY - ship.cvy;
        const steerL = Math.hypot(steerX, steerY) || 1;
        const fAmt   = Math.min(steerL, MAX_ACC * dt);
        ship.cvx += steerX / steerL * fAmt;
        ship.cvy += steerY / steerL * fAmt;
        const spd = Math.hypot(ship.cvx, ship.cvy);
        if (spd > MAX_SPD) { ship.cvx *= MAX_SPD / spd;  ship.cvy *= MAX_SPD / spd; }

        ship.sprite.x += ship.cvx * dt;
        ship.sprite.y += ship.cvy * dt;
        const angle   = Math.atan2(ship.cvy, ship.cvx);
        ship.sprite.rotation = angle + SolarSystemRenderer.SHIP_ROT_OFFSET;
        ship.sprite.alpha    = 1;

        let dAng = angle - ship.combatPrevAngle;
        if (dAng >  Math.PI) dAng -= Math.PI * 2;
        if (dAng < -Math.PI) dAng += Math.PI * 2;
        ship.combatPrevAngle = angle;
        planet3d.updateShipPose(ship.shipId, Math.max(-1, Math.min(1, dAng * 55)), 0);

        // No exhaust plume — trail only
        ship.flameGfx.clear();

        // Trail
        ship.trailPoints.push({ x: ship.sprite.x, y: ship.sprite.y });
        if (ship.trailPoints.length > 600) ship.trailPoints.shift();
        this._drawTrail(ship);

        // Fire — suppress when retreating (save energy for escape)
        ship.fireCooldown -= dt;
        if (ship.fireCooldown <= 0 && ship.combatState !== 'RETREAT') {
          ship.fireCooldown = 0.5 + Math.random() * 0.6;
          const pAng = Math.atan2(predTy - ship.sprite.y, predTx - ship.sprite.x)
                     + (Math.random() - 0.5) * 0.10;
          this._projectiles.push({ x: ship.sprite.x, y: ship.sprite.y,
            vx: Math.cos(pAng) * PROJ_SPD, vy: Math.sin(pAng) * PROJ_SPD,
            ownerId: ship.shipId, targetShip: tgt,
            damage: 1, life: 2.0, maxLife: 2.0, hit: false });  // 1 dmg → 3 hits to kill
          this._lasers.push({ x1: ship.sprite.x, y1: ship.sprite.y,
            x2: tgt.sprite.x, y2: tgt.sprite.y, life: 0.12, maxLife: 0.12 });
        }
        continue;
      } else if (ship.isFighting && (!ship.combatTarget || ship.combatTarget.dwell > 0)) {
        ship.isFighting = false;  ship.combatTarget = null;
        ship.cvx = 0;  ship.cvy = 0;  // bleed off combat velocity so bezier resumes cleanly
      }

      // ── Normal bezier flight ─────────────────────────────────────────────────
      ship.progress += ship.speed * dt;

      if (ship.progress >= 1.0) {
        ship.fromPlanet  = ship.toPlanet;
        const others     = this._livePlanets.filter(p => p.id !== ship.fromPlanet?.id);
        if (others.length) ship.toPlanet = others[Math.floor(Math.random() * others.length)];
        ship.progress    = 0;
        ship.arcSign     = Math.random() < 0.5 ? 1 : -1;
        ship.arcFactor   = 0.22 + Math.random() * 0.22;
        ship.trailPoints = [];
        ship.dwell       = 3.0 + Math.random() * 2.0;
        ship.prevAngle   = 0;
        ship.barrelTimer = 5 + Math.random() * 13;
        ship.stuntTimer  = 4 + Math.random() * 10;
        ship.stunType    = null;
        ship.trailGfx.clear(); ship.flameGfx.clear();
        if (!ship.noBonusOnArrival) api.tradeShipVisit().catch(() => {});
        ship.noBonusOnArrival = false;
        continue;
      }

      const fromCtr = this.planetGfx.get(ship.fromPlanet?.id);
      const toCtr   = this.planetGfx.get(ship.toPlanet?.id);
      if (!fromCtr || !toCtr) continue;

      const fx = fromCtr.x, fy = fromCtr.y, ntx = toCtr.x, nty = toCtr.y;
      const dx = ntx - fx, dy = nty - fy, dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist, ny = dx / dist;
      const arc = dist * ship.arcFactor * ship.arcSign;
      const c1x = fx + dx * 0.25 + nx * arc, c1y = fy + dy * 0.25 + ny * arc;
      const c2x = fx + dx * 0.75 + nx * arc, c2y = fy + dy * 0.75 + ny * arc;
      const t = ship.progress, mt = 1 - t;
      const bx = mt*mt*mt*fx + 3*mt*mt*t*c1x + 3*mt*t*t*c2x + t*t*t*ntx;
      const by = mt*mt*mt*fy + 3*mt*mt*t*c1y + 3*mt*t*t*c2y + t*t*t*nty;
      const tbx = 3*(mt*mt*(c1x-fx) + 2*mt*t*(c2x-c1x) + t*t*(ntx-c2x));
      const tby = 3*(mt*mt*(c1y-fy) + 2*mt*t*(c2y-c1y) + t*t*(nty-c2y));
      const angle = Math.atan2(tby, tbx);

      let dAngle = angle - ship.prevAngle;
      if (dAngle >  Math.PI) dAngle -= Math.PI * 2;
      if (dAngle < -Math.PI) dAngle += Math.PI * 2;
      ship.prevAngle = angle;

      // ── Stunt system ─────────────────────────────────────────────────────────
      ship.barrelTimer -= dt;
      ship.stuntTimer  -= dt;
      const midFlight = t > 0.15 && t < 0.85;
      if (ship.barrelTimer <= 0 && midFlight && !ship.stunType) {
        planet3d.triggerBarrelRoll(ship.shipId);
        ship.barrelTimer = 6 + Math.random() * 14;
      }
      if (ship.stuntTimer <= 0 && midFlight && !ship.stunType) {
        const types = ['weave', 'divePull', 'weave', 'highG'];
        ship.stunType  = types[Math.floor(Math.random() * types.length)];
        ship.stunPhase = 0;
        ship.stunDur   = ship.stunType === 'weave' ? 2.8 : (ship.stunType === 'highG' ? 1.2 : 1.8);
        ship.stuntTimer = 6 + Math.random() * 12;
      }
      let bankOverride = null, pitchOverride = null;
      if (ship.stunType) {
        ship.stunPhase += dt;
        if (ship.stunPhase >= ship.stunDur) { ship.stunType = null; }
        else if (ship.stunType === 'weave')    { bankOverride  = Math.sin(ship.stunPhase * 5.0) * 1.1; }
        else if (ship.stunType === 'divePull') { pitchOverride = Math.sin(ship.stunPhase / ship.stunDur * Math.PI) * 0.8; }
        else if (ship.stunType === 'highG')    { bankOverride  = (ship.arcSign > 0 ? 1 : -1) * 0.95; }
      }
      const bankAngle  = bankOverride  ?? Math.max(-1.0, Math.min(1.0, dAngle * 80));
      const pitchAngle = pitchOverride ?? Math.cos(Math.PI * t) * 0.3;
      planet3d.updateShipPose(ship.shipId, bankAngle, pitchAngle);

      ship.sprite.x = bx; ship.sprite.y = by;
      ship.sprite.rotation = angle + SolarSystemRenderer.SHIP_ROT_OFFSET;
      if (t < 0.06)       ship.sprite.alpha = t / 0.06;
      else if (t > 0.88)  ship.sprite.alpha = 1 - (t - 0.88) / 0.12;
      else                ship.sprite.alpha = 1;
      const fa = ship.sprite.alpha;

      // No exhaust plume — trail only
      ship.flameGfx.clear();

      // Smoke trail — growing dot cloud fading from newest (bright) to oldest (gone)
      ship.trailPoints.push({ x: bx, y: by });
      if (ship.trailPoints.length > 600) ship.trailPoints.shift();
      this._drawTrail(ship);
    }

    this._tickCombat(dt);
    planet3d.tickAllShips(deltaTime);
  }

  _drawTrail(ship) {
    ship.trailGfx.clear();
    const pts = ship.trailPoints;
    const len = pts.length;
    // Only draw every 3rd point to keep batches small while still covering long distances
    for (let i = 0; i < len; i += 3) {
      const ratio = i / Math.max(1, len - 1); // 0=oldest/transparent, 1=newest/visible
      const a = ratio * ratio * 0.55;         // quadratic: head bright, tail invisible
      if (a < 0.005) continue;
      ship.trailGfx.circle(pts[i].x, pts[i].y, 0.15 + ratio * 0.7);
      ship.trailGfx.fill({ color: 0xbbddff, alpha: a });
    }
  }

  _tickCombat(dt) {
    // Advance projectiles
    for (const p of this._projectiles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }

    // Hit detection — destroyedThisFrame prevents mutual simultaneous kills
    const hitR = Math.max(8, 12 / this._worldScale);
    const destroyedThisFrame = new Set();
    for (const p of this._projectiles) {
      if (p.hit || p.life <= 0) continue;
      const s = p.targetShip;
      if (!s || s.dwell > 0 || !s.isFighting || destroyedThisFrame.has(s)) { p.hit = true; continue; }
      if (Math.hypot(p.x - s.sprite.x, p.y - s.sprite.y) < hitR) {
        p.hit  = true;
        s.hp  -= p.damage;
        if (s.hp <= 0) { destroyedThisFrame.add(s); this._destroyShip(s); }
      }
    }
    this._projectiles = this._projectiles.filter(p => p.life > 0 && !p.hit);
    for (const l of this._lasers) l.life -= dt;
    this._lasers = this._lasers.filter(l => l.life > 0);

    if (!this._combatGfx) return;
    this._combatGfx.clear();
    // White orb projectiles with soft blue glow
    for (const p of this._projectiles) {
      this._combatGfx.circle(p.x, p.y, 2.8);
      this._combatGfx.fill({ color: 0x8888ff, alpha: 0.30 });
      this._combatGfx.circle(p.x, p.y, 1.6);
      this._combatGfx.fill({ color: 0xffffff, alpha: 0.92 });
    }
    // Red laser beams + orange death flashes
    for (const l of this._lasers) {
      const a = (l.life / l.maxLife) * 0.88;
      this._combatGfx.moveTo(l.x1, l.y1).lineTo(l.x2, l.y2);
      this._combatGfx.stroke({ color: l.color ?? 0xff2222, width: 0.9, alpha: a });
    }
  }

  _destroyShip(s) {
    const ex = s.sprite.x, ey = s.sprite.y;
    // Break both ships out of combat before doing anything else
    if (s.combatTarget) {
      const winner = s.combatTarget;
      winner.isFighting   = false;
      winner.combatTarget = null;
      winner.cvx = 0;  winner.cvy = 0;   // shed combat velocity
      // Resume bezier flight on a fresh arc from current position
      winner.progress  = 0;
      winner.arcSign   = Math.random() < 0.5 ? 1 : -1;
      winner.arcFactor = 0.22 + Math.random() * 0.22;
      winner.hp        = winner.maxHp;   // winner restored to full for next fight
      winner.bounty   += 1;              // earn a bounty point for each kill
    }
    s.isFighting     = false;
    s.combatTarget   = null;
    s.cvx = 0;  s.cvy = 0;
    s.hp             = s.maxHp;
    s.dwell          = 12 + Math.random() * 6;  // 12-18s respawn blackout
    s.noBonusOnArrival = true;
    s.trailPoints    = [];  s.trailGfx.clear();  s.flameGfx.clear();
    s.sprite.alpha   = 0;
    // Purge all projectiles targeting this ship so they can't re-trigger death
    this._projectiles = this._projectiles.filter(p => p.targetShip !== s);
    // Explosion: three expanding X rings in white → orange → red
    for (let r = 0; r < 3; r++) {
      const sz = 5 + r * 5;
      const col = r === 0 ? 0xffffff : (r === 1 ? 0xffaa22 : 0xff3300);
      const life = 0.55 + r * 0.18;
      this._lasers.push({ x1: ex - sz, y1: ey - sz, x2: ex + sz, y2: ey + sz, life, maxLife: life, color: col });
      this._lasers.push({ x1: ex + sz, y1: ey - sz, x2: ex - sz, y2: ey + sz, life, maxLife: life, color: col });
    }
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
