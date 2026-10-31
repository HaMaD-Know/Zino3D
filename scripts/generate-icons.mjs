// Renders public/icons/zino3d.svg to the PNG sizes required by the PWA manifest, iOS and Android.
// Usage: node scripts/generate-icons.mjs   (uses the Playwright Chromium already used for UI tests)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(root, 'public/icons/zino3d.svg'), 'utf8');
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const targets = [
  { file: 'public/icons/icon-192.png', size: 192 },
  { file: 'public/icons/icon-512.png', size: 512 },
  { file: 'public/icons/apple-touch-icon.png', size: 180, opaque: true },
  { file: 'public/icons/icon-maskable-512.png', size: 512, maskable: true },
];

// Native platform icons (written only if the platform folders exist).
const android = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];
if (existsSync(resolve(root, 'android/app/src/main/res'))) {
  for (const [density, size] of android) {
    targets.push({ file: `android/app/src/main/res/mipmap-${density}/ic_launcher.png`, size });
    targets.push({
      file: `android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`,
      size,
      round: true,
    });
    targets.push({
      file: `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`,
      size: Math.round(size * 2.25),
      maskable: true,
      transparent: true,
    });
  }
}
const iosIcon = 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';
if (existsSync(resolve(root, dirname(iosIcon)))) targets.push({ file: iosIcon, size: 1024, opaque: true });

// Splash screens: dark background with the centred icon (replaces Capacitor's default artwork).
const splashes = [];
const androidRes = resolve(root, 'android/app/src/main/res');
if (existsSync(androidRes)) {
  const sizes = {
    mdpi: [320, 480],
    hdpi: [480, 800],
    xhdpi: [720, 1280],
    xxhdpi: [960, 1600],
    xxxhdpi: [1280, 1920],
  };
  for (const [d, [w, h]] of Object.entries(sizes)) {
    splashes.push({ file: `android/app/src/main/res/drawable-port-${d}/splash.png`, w, h });
    splashes.push({ file: `android/app/src/main/res/drawable-land-${d}/splash.png`, w: h, h: w });
  }
  splashes.push({ file: 'android/app/src/main/res/drawable/splash.png', w: 480, h: 320 });
}
const iosSplash = resolve(root, 'ios/App/App/Assets.xcassets/Splash.imageset');
if (existsSync(iosSplash)) {
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    splashes.push({ file: `ios/App/App/Assets.xcassets/Splash.imageset/${f}`, w: 2732, h: 2732 });
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  const inner = t.maskable ? Math.round(t.size * 0.72) : t.size;
  const bg = t.transparent ? 'transparent' : t.maskable || t.opaque ? '#17181b' : 'transparent';
  const radius = t.round ? '50%' : '0';
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<html><body style="margin:0;background:${bg};width:${t.size}px;height:${t.size}px;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:${radius}">
      <img src="${dataUrl}" width="${inner}" height="${inner}" style="display:block${t.round ? ';border-radius:50%' : ''}"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  const out = resolve(root, t.file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await page.screenshot({ omitBackground: bg === 'transparent', type: 'png' }));
  console.log(`wrote ${t.file}`);
}
for (const sp of splashes) {
  const icon = Math.round(Math.min(sp.w, sp.h) * 0.28);
  await page.setViewportSize({ width: sp.w, height: sp.h });
  await page.setContent(
    `<html><body style="margin:0;background:#16171a;width:${sp.w}px;height:${sp.h}px;display:flex;align-items:center;justify-content:center">
      <img src="${dataUrl}" width="${icon}" height="${icon}"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  writeFileSync(resolve(root, sp.file), await page.screenshot({ type: 'png' }));
  console.log(`wrote ${sp.file}`);
}
await browser.close();
