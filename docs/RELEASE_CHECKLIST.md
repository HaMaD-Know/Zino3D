# Release checklist

## Automated (must be green)

- [ ] `npm ci && npm run format:check && npm run lint && npm run typecheck`
- [ ] `npm test` (Vitest)
- [ ] `npm run build && npm run test:e2e` (Playwright: desktop, tablet, phone)
- [ ] `npm run licenses` (only permissive production licenses)
- [ ] `npm audit --omit=dev` reviewed
- [ ] GitHub Actions: Web CI, Android build, iOS build all green on the release commit

## Manual — core workflow on each target (desktop browser, iPad, iPhone, Android phone/tablet)

- [ ] Create project, import a real AI-generated GLB (e.g. Tripo export), check stats and warnings
- [ ] Select via viewport and hierarchy, rename, move/rotate/scale with gizmo and numeric fields
- [ ] Separate loose parts; wheel assistant on a car model; Edit Mode face separation on a fused model
- [ ] Material edits (color, metallic, roughness, opacity) render correctly; shared-material “make unique”
- [ ] Undo/redo every step above
- [ ] Export GLB → re-import → object count, names, transforms and materials match
- [ ] Close app during editing → reopen → recovery banner → project intact
- [ ] Airplane mode: launch app, open project, edit, export
- [ ] Download `.zino3d` and open it on another device
- [ ] Large-file test (≥ 1M triangles, ≥ 4k textures): import time, memory, responsiveness, diagnostics panel

## Native

- [ ] Android: debug APK installs; file picker opens `.glb`; export opens share sheet; back button behaviour
- [ ] Android: signed release APK/AAB built with the production keystore (stored offline, backed up)
- [ ] iOS: signed IPA installs on registered devices / TestFlight; Files app import and Share-sheet export
- [ ] Safe areas correct in portrait/landscape on notch devices; orientation changes keep the layout usable

## Paperwork

- [ ] Version bumped (`package.json`, Android `versionName`, iOS marketing version)
- [ ] docs/LIMITATIONS.md updated
- [ ] Project license chosen and added
