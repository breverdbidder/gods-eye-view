#!/usr/bin/env node
/**
 * mapbox-orbit.mjs
 *
 * Cinematic 3D orbit VIDEO of a parcel, headless - the GEV replacement path.
 * Mapbox GL JS satellite + terrain (1.5x DEM) + extruded buildings, captured
 * frame-by-frame via Playwright, assembled to MP4 with ffmpeg.
 *
 *   node tools/mapbox-orbit.mjs --lookat-lat 28.022716 --lookat-lon -80.587274 --out orbit.mp4
 *
 * Options:
 *   --lookat-lat  Parcel latitude (required)
 *   --lookat-lon  Parcel longitude (required)
 *   --frames      Frame count, one full 360-degree orbit (default: 144)
 *   --fps         Output framerate (default: 24)
 *   --width       Frame width px (default: 1280)
 *   --height-px   Frame height px (default: 720)
 *   --settle-ms   Per-frame tile settle wait (default: 400; raise on slow links)
 *   --zoom-start  Orbit start zoom (default: 15.5)
 *   --zoom-end    Orbit end zoom, reached at 35% of the orbit (default: 17.8)
 *   --pitch-end   Max pitch, reached at 35% (default: 62)
 *   --out         Output MP4 path (default: output/orbit.mp4)
 *   --keep-frames Keep the PNG frame dir (default: deleted after encode)
 *   --token       Mapbox token (default: $MAPBOX_TOKEN, then the app's public pk)
 *
 * Cost: public-pk token usage only - Mapbox free tier is 50k map loads/mo for
 * GL JS; one orbit is one map load plus tile/DEM requests. No paid APIs.
 *
 * Dependencies: playwright (+ chromium), ffmpeg on PATH.
 * Software-GL notes for the Dell: we launch with swiftshader flags; capture is
 * canvas.toDataURL per frame (page.screenshot stalls on this stack).
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { frames: 144, fps: 24, width: 1280, heightPx: 720, settleMs: 400,
    zoomStart: 15.5, zoomEnd: 17.8, pitchEnd: 62, out: 'output/orbit.mp4', keepFrames: false,
    token: process.env.MAPBOX_TOKEN };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '--lookat-lat': o.lat = parseFloat(a[++i]); break;
      case '--lookat-lon': o.lon = parseFloat(a[++i]); break;
      case '--frames': o.frames = parseInt(a[++i], 10); break;
      case '--fps': o.fps = parseInt(a[++i], 10); break;
      case '--width': o.width = parseInt(a[++i], 10); break;
      case '--height-px': o.heightPx = parseInt(a[++i], 10); break;
      case '--settle-ms': o.settleMs = parseInt(a[++i], 10); break;
      case '--zoom-start': o.zoomStart = parseFloat(a[++i]); break;
      case '--zoom-end': o.zoomEnd = parseFloat(a[++i]); break;
      case '--pitch-end': o.pitchEnd = parseFloat(a[++i]); break;
      case '--out': o.out = a[++i]; break;
      case '--keep-frames': o.keepFrames = true; break;
      case '--token': o.token = a[++i]; break;
      default: throw new Error(`unknown arg ${a[i]}`);
    }
  }
  if (!o.token) {
    console.error('Mapbox token required: --token <pk...> or MAPBOX_TOKEN env (use the public pk already shipping on biddeed.ai)');
    process.exit(2);
  }
  if (o.lat === undefined || o.lon === undefined) {
    console.error('required: --lookat-lat <lat> --lookat-lon <lon>');
    process.exit(2);
  }
  return o;
}

const o = parseArgs();
const frameDir = join(dirname(resolve(o.out)), `.orbit-frames-${Date.now()}`);
mkdirSync(frameDir, { recursive: true });

const html = readFileSync(join(__dirname, 'mapbox-orbit.html'), 'utf8')
  .replaceAll('%%TOKEN%%', o.token)
  .replaceAll('%%LAT%%', String(o.lat))
  .replaceAll('%%LNG%%', String(o.lon))
  .replaceAll('%%W%%', String(o.width))
  .replaceAll('%%H%%', String(o.heightPx));
const htmlPath = join(frameDir, 'orbit.html');
writeFileSync(htmlPath, html);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: o.width, height: o.heightPx } });
await page.goto('file://' + htmlPath);
await page.waitForFunction('window.READY === true', null, { timeout: 90000 });
// let the base tiles settle once before the orbit starts
await page.evaluate(`new Promise(res => { const m = window; (function w(){ document.querySelector('#map canvas') ? res() : setTimeout(w, 200); })(); })`);
await page.waitForTimeout(1500);

const t0 = Date.now();
for (let i = 0; i < o.frames; i++) {
  const t = i / (o.frames - 1);
  const ramp = Math.min(1, t / 0.35);
  const zoom = o.zoomStart + (o.zoomEnd - o.zoomStart) * ramp;
  const pitch = o.pitchEnd * ramp;
  const bearing = 360 * t;
  await page.evaluate(`window.setCam(${zoom}, ${pitch}, ${bearing})`);
  await page.waitForTimeout(o.settleMs);
  const data = await page.evaluate(`document.querySelector('#map canvas').toDataURL('image/png')`);
  writeFileSync(join(frameDir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(data.split(',')[1], 'base64'));
  if (i % 24 === 0) console.log(`frame ${i}/${o.frames}`);
}
await browser.close();

mkdirSync(dirname(resolve(o.out)), { recursive: true });
execFileSync('ffmpeg', ['-y', '-framerate', String(o.fps), '-i', join(frameDir, 'f%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', resolve(o.out)], { stdio: 'inherit' });
if (!o.keepFrames) rmSync(frameDir, { recursive: true, force: true });
console.log(`DONE ${o.out} (${o.frames} frames, ${Date.now() - t0}ms capture)`);
