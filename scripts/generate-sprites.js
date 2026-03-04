/**
 * scripts/generate-sprites.js
 * Builds a sprite sheet from all PNGs in src/sprites/
 * Output → public/assets/sprites/sheet.png + sheet.json
 *
 * Usage: npm run sprites
 */
const Spritesmith = require('spritesmith');
const fs = require('fs');
const path = require('path');

const INPUT_GLOB = path.join(__dirname, '../src/sprites/*.png');
const OUT_DIR    = path.join(__dirname, '../public/assets/sprites');
const OUT_IMG    = path.join(OUT_DIR, 'sheet.png');
const OUT_JSON   = path.join(OUT_DIR, 'sheet.json');

// Collect source images
const glob = require('fs').readdirSync(path.join(__dirname, '../src/sprites')).filter(f => f.endsWith('.png'));
if (glob.length === 0) {
  console.warn('[sprites] No PNG files found in src/sprites/ – create some first.');
  process.exit(0);
}

const srcImages = glob.map(f => path.join(__dirname, '../src/sprites', f));

Spritesmith.run({ src: srcImages }, (err, result) => {
  if (err) { console.error('[sprites] Error:', err); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_IMG, result.image);

  // Convert coordinates → PixiJS-compatible atlas JSON
  const frames = {};
  for (const [filePath, coords] of Object.entries(result.coordinates)) {
    const name = path.basename(filePath);
    frames[name] = {
      frame: { x: coords.x, y: coords.y, w: coords.width, h: coords.height },
      sourceSize: { w: coords.width, h: coords.height },
      spriteSourceSize: { x: 0, y: 0, w: coords.width, h: coords.height },
    };
  }

  const atlas = {
    frames,
    meta: {
      image: 'sheet.png',
      size: { w: result.properties.width, h: result.properties.height },
      scale: '1',
    },
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(atlas, null, 2));
  console.log(`[sprites] Sheet → ${OUT_IMG}`);
  console.log(`[sprites] Atlas → ${OUT_JSON}`);
});
