// public/js/game/planet3d.js
// Full 3D planet management — per-planet Three.js scenes rendered into canvases
// that PixiJS uses as live sprite textures, plus a full-screen viewer modal.
import * as THREE    from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_PATH  = '/assets/planets/';
const THUMB_SIZE  = 160;    // thumbnail canvas (px)

const FALLBACK_COLORS = {
  rocky: 0x8B7355, gas: 0xE8A87C, ocean: 0x1E6BA8,
  ice: 0xADD8E6,   volcanic: 0xCC3300, crystal: 0x9370DB,
};

// Client-side pools — mirrors server manifest, used for legacy planets without model_file
const MODEL_POOLS = {
  rocky:    ['Fossil_Planet.glb','Mars_Red_planet.glb','Rust_Planet.glb','Rusted_Planet.glb','Dark_Metal_Planet.glb','Metallic_Planet.glb','Light_Metal_Planet.glb'],
  gas:      ['Dark_Blue_Purple_Green_Slime_Planet.glb','Greenish_Saturn_Ringed_Planet.glb'],
  ocean:    ['Blue_Water_beaches_Planet.glb','Earth_Planet.glb','Tropical_EarthLike_Planet.glb','Water_Planet.glb'],
  ice:      ['Greenish_Saturn_Ringed_Planet.glb','Light_Metal_Planet.glb','Metallic_Planet.glb'],
  volcanic: ['Red_Orange_Planet.glb','Weird_Vulcanic_Planet.glb','Mars_Red_planet.glb'],
  crystal:  ['Mystic_Planet.glb','Man_Made_Planet_1.glb','Man_Made_Planet_2.glb','Man_Made_Planet_3.glb'],
};
const MOON_POOL  = ['Dark_Metal_Planet.glb','Fossil_Planet.glb','Rust_Planet.glb','Metallic_Planet.glb','Rusted_Planet.glb'];
const STAR_MODEL = 'Sun.glb';

// ── Three.js helpers ──────────────────────────────────────────────────────────
function addLights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xfffae0, 2.4);
  key.position.set(5, 8, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x8899cc, 0.5);
  fill.position.set(-5, -2, 2);
  scene.add(fill);
}

function normaliseGltf(root) {
  const box    = new THREE.Box3().setFromObject(root);
  const centre = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  root.scale.setScalar(2.0 / maxDim);
  root.position.sub(centre.multiplyScalar(2.0 / maxDim));
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
class Planet3DManager {
  constructor() {
    this._renderer   = null;         // shared thumbnail renderer
    this._loader     = new GLTFLoader();
    this._modelCache = new Map();    // filename → THREE.Group (with ._clips)
    this._loading    = new Map();    // filename → Promise
    this._planets    = new Map();    // planetId → entry
    this._available  = false;

    // Viewer state
    this._vRen     = null;
    this._vCanvas  = null;   // the live <canvas> element inside wrap
    this._vScene   = null;
    this._vCamera  = null;
    this._vPivot   = null;
    this._vMixers  = [];
    this._vActive  = false;
    this._vFrameId = null;
  }

  async init() {
    try {
      this._renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,           // not needed for small thumbnails
        preserveDrawingBuffer: true, // REQUIRED — lets ctx.drawImage read the GL canvas
        powerPreference: 'low-power',
      });
      this._renderer.setSize(THUMB_SIZE, THUMB_SIZE);
      this._renderer.setPixelRatio(1);  // keep 1:1 so drawImage copies the full frame
      this._renderer.outputColorSpace = THREE.SRGBColorSpace;
      this._available = true;
      console.log('[Planet3D] Three.js WebGL thumbnail renderer ready');
    } catch (err) {
      console.warn('[Planet3D] WebGL unavailable — falling back to 2D sprites:', err.message);
    }
    this._loadModel(STAR_MODEL).catch(() => {});
  }

  // ── Model cache ────────────────────────────────────────────────────────────
  async _loadModel(filename) {
    if (this._modelCache.has(filename)) return this._modelCache.get(filename);
    if (this._loading.has(filename))    return this._loading.get(filename);
    const p = this._loader.loadAsync(MODEL_PATH + filename)
      .then(gltf => {
        const r = normaliseGltf(gltf.scene);
        r.userData._clips = gltf.animations || [];   // preserve animation clips
        this._modelCache.set(filename, r);
        this._loading.delete(filename);
        return r;
      })
      .catch(err => { console.warn('[Planet3D]', filename, err.message); this._loading.delete(filename); return null; });
    this._loading.set(filename, p);
    return p;
  }

  _clone(orig) { return orig ? orig.clone(true) : null; }

  _sphere(type) {
    return new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshPhongMaterial({ color: FALLBACK_COLORS[type] || 0x888888, shininess: 30 })
    );
  }

  _pickModel(type, seed) {
    const pool = MODEL_POOLS[type] || MODEL_POOLS.rocky;
    return pool[seed % pool.length];
  }

  _parseMoons(raw) {
    if (!raw) return [];
    try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a : []; }
    catch { return []; }
  }

  // ── Register a planet — canvas + texture created immediately, model async ──
  registerPlanet(planet) {
    if (!this._available || this._planets.has(planet.id)) return;

    const modelFile    = planet.model_file    || this._pickModel(planet.type, planet.id);
    const selfRotSpeed = planet.self_rotation != null ? Number(planet.self_rotation) : 0.004;
    const sizeScale    = planet.size_scale    != null ? Number(planet.size_scale)    : 1.0;
    const moonData     = this._parseMoons(planet.moon_data);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = THUMB_SIZE;

    // PIXI v8: use CanvasSource for live-updating canvas textures
    const source  = new PIXI.CanvasSource({ resource: canvas });
    const texture = new PIXI.Texture({ source });

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.z = 3.8;
    addLights(scene);

    const pivot = new THREE.Group();
    scene.add(pivot);

    const entry = { canvas, texture, scene, camera, pivot,
      planetMesh: null, selfRotSpeed, selfAngle: Math.random() * Math.PI * 2,
      sizeScale, moons: [], ready: false };
    this._planets.set(planet.id, entry);

    // Show a fallback sphere immediately so the planet is never invisible
    const tempMesh = this._sphere(planet.type);
    pivot.add(tempMesh);
    entry.ready = true;
    this._renderEntry(entry);
    entry.texture.source.update();

    (async () => {
      const orig = await this._loadModel(modelFile);
      const mesh = orig ? this._clone(orig) : this._sphere(planet.type);
      mesh.scale.multiplyScalar(sizeScale);
      // Swap out temp sphere for the real model
      pivot.remove(tempMesh);
      pivot.add(mesh);
      entry.planetMesh = mesh;

      for (const md of moonData) {
        const mo = await this._loadModel(md.model_file || MOON_POOL[0]);
        const mm = mo ? this._clone(mo) : this._sphere('rocky');
        mm.scale.setScalar(md.size_scale || 0.15);
        scene.add(mm);
        entry.moons.push({ mesh: mm, radius: md.orbital_radius || 1.8, speed: md.orbital_speed || 0.018, tilt: md.tilt || 0, angle: Math.random() * Math.PI * 2 });
      }
      entry.ready = true;
      this._renderEntry(entry);
      entry.texture.source.update(); // notify PIXI to re-upload immediately
    })();
  }

  _renderEntry(entry) {
    if (!this._available) return;
    this._renderer.render(entry.scene, entry.camera);
    const ctx = entry.canvas.getContext('2d');
    ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    // Explicit target size so pixel-ratio differences don't cause a cropped blit
    ctx.drawImage(this._renderer.domElement, 0, 0, THUMB_SIZE, THUMB_SIZE);
  }

  // ── Main tick ──────────────────────────────────────────────────────────────
  tick(deltaTime) {
    if (!this._available) return;
    for (const [, e] of this._planets) {
      if (!e.ready) continue;
      e.selfAngle += e.selfRotSpeed * deltaTime;
      e.pivot.rotation.y = e.selfAngle;
      for (const m of e.moons) {
        m.angle += m.speed * deltaTime;
        m.mesh.position.set(
          Math.cos(m.angle) * m.radius,
          Math.sin(m.angle * 0.5 + m.tilt) * m.radius * 0.18,
          Math.sin(m.angle) * m.radius
        );
        m.mesh.rotation.y += 0.02 * deltaTime;
      }
      this._renderEntry(e);
      e.texture.source.update();  // PIXI v8: notify GPU to re-upload the canvas
    }
  }

  getTexture(planetId)   { return this._planets.get(planetId)?.texture || null; }
  isRegistered(planetId) { return this._planets.has(planetId); }

  unregisterPlanet(planetId) {
    const e = this._planets.get(planetId);
    if (e) { e.texture.destroy(); this._planets.delete(planetId); }
  }

  // ── Viewer ─────────────────────────────────────────────────────────────────
  // wrapEl is the container div — a fresh <canvas> is created inside it each time,
  // avoiding the "dead WebGL context on re-use" bug.
  openViewer(planet, wrapEl) {
    this.closeViewer();

    // Create a brand-new canvas so Three.js gets a fresh WebGL context every time
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;position:absolute;top:0;left:0;width:100%;height:100%';
    wrapEl.appendChild(canvas);
    this._vCanvas = canvas;

    const rect = wrapEl.getBoundingClientRect();
    const W    = rect.width  || 640;
    const H    = rect.height || 480;
    canvas.width  = W;
    canvas.height = H;

    this._vRen = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this._vRen.setSize(W, H, false);
    this._vRen.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this._vRen.outputColorSpace = THREE.SRGBColorSpace;

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 200);
    camera.position.set(0, 0.8, 5.8);
    camera.lookAt(0, 0, 0);
    this._vScene  = scene;
    this._vCamera = camera;
    this._vMixers = [];

    // Rich lighting
    scene.add(new THREE.AmbientLight(0x334466, 0.4));
    const sun = new THREE.DirectionalLight(0xffeedd, 3.2); sun.position.set(8, 10, 8); scene.add(sun);
    const rim = new THREE.DirectionalLight(0x4488ff, 0.6); rim.position.set(-8, -3, -5); scene.add(rim);

    // Background star field
    const sg = new THREE.BufferGeometry();
    const sp = new Float32Array(1200);
    for (let i = 0; i < 1200; i++) sp[i] = (Math.random() - 0.5) * 200;
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, sizeAttenuation: true })));

    const pivot  = new THREE.Group();
    scene.add(pivot);
    this._vPivot = pivot;
    const vMoons = [];

    const modelFile    = planet.model_file    || this._pickModel(planet.type, planet.id);
    const selfRotSpeed = Number(planet.self_rotation || 0.003);
    const sizeScale    = Number(planet.size_scale    || 1.0);
    const moonData     = this._parseMoons(planet.moon_data);

    let selfAngle = 0;
    (async () => {
      const orig = await this._loadModel(modelFile);
      const mesh = orig ? this._clone(orig) : this._sphere(planet.type);
      mesh.scale.setScalar(sizeScale);
      pivot.add(mesh);
      for (const md of moonData) {
        const mo = await this._loadModel(md.model_file || MOON_POOL[0]);
        const mm = mo ? this._clone(mo) : this._sphere('rocky');
        mm.scale.setScalar((md.size_scale || 0.15) * 1.4);
        scene.add(mm);
        vMoons.push({ mesh: mm, radius: (md.orbital_radius || 1.8) * 1.6, speed: (md.orbital_speed || 0.018) * 0.6, tilt: md.tilt || 0, angle: Math.random() * Math.PI * 2 });
      }
    })();

    this._vActive = true;
    const clock = new THREE.Clock();
    const loop = () => {
      if (!this._vActive) return;
      const dt = clock.getDelta();
      for (const m of this._vMixers) m.update(dt);
      selfAngle += selfRotSpeed * 0.7;
      pivot.rotation.y = selfAngle;
      for (const m of vMoons) {
        m.angle += m.speed;
        m.mesh.position.set(Math.cos(m.angle) * m.radius, Math.sin(m.angle * 0.5 + m.tilt) * m.radius * 0.2, Math.sin(m.angle) * m.radius);
        m.mesh.rotation.y += 0.012;
      }
      this._vRen.render(scene, camera);
      this._vFrameId = requestAnimationFrame(loop);
    };
    this._vFrameId = requestAnimationFrame(loop);
  }

  closeViewer() {
    this._vActive = false;
    if (this._vFrameId) { cancelAnimationFrame(this._vFrameId); this._vFrameId = null; }
    if (this._vRen)     { this._vRen.dispose(); this._vRen = null; }
    if (this._vCanvas)  { this._vCanvas.remove(); this._vCanvas = null; }
    this._vScene = null; this._vCamera = null; this._vPivot = null; this._vMixers = [];
  }

  // ── Explode the planet in the viewer, then call onComplete ─────────────────
  // Plays Planet_Explosion.glb animation + shatters the planet mesh outward.
  explodeInViewer(planet, onComplete) {
    if (!this._vScene || !this._vPivot || !this._vRen) { onComplete?.(); return; }

    // Pause the normal loop
    this._vActive = false;
    if (this._vFrameId) { cancelAnimationFrame(this._vFrameId); this._vFrameId = null; }

    const scene  = this._vScene;
    const camera = this._vCamera;
    const pivot  = this._vPivot;
    const ren    = this._vRen;

    // ── Spawn debris chunks ────────────────────────────────────────────────
    const debris  = [];
    const source  = pivot.children[0] || pivot;
    const CHUNKS  = 12;
    for (let i = 0; i < CHUNKS; i++) {
      const chunk = source.clone(true);
      chunk.scale.setScalar((0.08 + Math.random() * 0.28) * Number(planet.size_scale || 1));
      // random position on planet surface
      const phi = Math.random() * Math.PI * 2, theta = Math.random() * Math.PI;
      chunk.position.set(
        Math.sin(theta) * Math.cos(phi) * 0.5,
        Math.cos(theta) * 0.5,
        Math.sin(theta) * Math.sin(phi) * 0.5,
      );
      // outward velocity
      const vel = chunk.position.clone().normalize().multiplyScalar(1.8 + Math.random() * 2.5);
      vel.x += (Math.random() - 0.5) * 2; vel.y += (Math.random() - 0.5) * 2; vel.z += (Math.random() - 0.5) * 2;
      const angVel = new THREE.Vector3((Math.random()-0.5)*10, (Math.random()-0.5)*10, (Math.random()-0.5)*10);
      // make materials transparent
      chunk.traverse(n => {
        if (n.isMesh) {
          const mats = Array.isArray(n.material) ? n.material : [n.material];
          n.material = mats.map(m => { const c = m.clone(); c.transparent = true; return c; });
        }
      });
      scene.add(chunk);
      debris.push({ mesh: chunk, vel, angVel, opacity: 1.0 });
    }
    pivot.visible = false; // hide original

    // ── Load explosion model & play its animations ─────────────────────────
    this._vMixers = [];
    const clock = new THREE.Clock();
    (async () => {
      const orig = await this._loadModel('Planet_Explosion.glb');
      if (orig) {
        const expMesh = this._clone(orig);
        expMesh.scale.setScalar(2.0);
        scene.add(expMesh);
        const clips = orig.userData._clips || [];
        if (clips.length > 0) {
          const mixer = new THREE.AnimationMixer(expMesh);
          clips.forEach(clip => mixer.clipAction(THREE.AnimationClip.findByName(clips, clip.name) || clip).play());
          this._vMixers.push(mixer);
        }
      }
    })();

    // ── Animate ────────────────────────────────────────────────────────────
    const DURATION  = 3500;
    const startTime = performance.now();

    const boom = () => {
      const dt       = clock.getDelta();
      const elapsed  = performance.now() - startTime;
      const progress = Math.min(elapsed / DURATION, 1);

      for (const m of this._vMixers) m.update(dt);

      for (const d of debris) {
        d.mesh.position.addScaledVector(d.vel, dt);
        d.vel.multiplyScalar(1.0 + dt * 0.8);  // accelerate
        d.mesh.rotation.x += d.angVel.x * dt;
        d.mesh.rotation.y += d.angVel.y * dt;
        d.mesh.rotation.z += d.angVel.z * dt;
        // fade out in last 60% of animation
        const fade = Math.max(0, 1 - Math.pow(Math.max(0, progress - 0.4) / 0.6, 1.5));
        d.mesh.traverse(n => {
          if (n.isMesh) {
            const mats = Array.isArray(n.material) ? n.material : [n.material];
            mats.forEach(m => { if (m.transparent) m.opacity = fade; });
          }
        });
      }

      if (ren) ren.render(scene, camera);

      if (progress < 1) {
        this._vFrameId = requestAnimationFrame(boom);
      } else {
        onComplete?.();
      }
    };
    this._vFrameId = requestAnimationFrame(boom);
  }
}

export const planet3d = new Planet3DManager();
