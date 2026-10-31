# Architecture

```
src/
  app/            App shell (screen routing), preferences, responsive layout hook
  components/ui/  Design-system primitives: Button, IconButton, Dialog, Menu, fields, Section, Toast
  features/       React feature modules (home, editor, hierarchy, inspector, import-export,
                  mesh-editing, settings). UI only — they call engine operations.
  engine/
    editor/       Editor (document state, ids, selection, modes, history) + operations
                  (objectOperations, meshOperations, materialOperations)
    history/      Command interface, bounded CommandHistory, concrete commands
    geometry/     Pure mesh algorithms on BufferGeometry / typed arrays (no React, no DOM)
    scene/        Object helpers, sample scenes
    serialization/ Native project format: schema + migrations, serializer, image codec
    viewport/     WebGL renderer, cameras, controls, gizmos, picking, edit overlays
  formats/        Import/export pipelines, validation, scene statistics
  storage/        IndexedDB wrapper, project repository, autosave session, recovery marker, bundles
  platform/       File picking / saving (browser + Capacitor), native shell integration
  workers/        Geometry worker (connected components for large meshes)
  styles/         tokens.css (design tokens), global/editor/responsive/home styles
```

## Data flow

- `Editor` owns a `THREE.Scene`; user content lives under `editor.root`. Editor lights, grid, gizmos and
  overlays live outside it, so they are never exported or saved.
- Every change goes through `editor.execute(command)` (or `editor.record` for gizmo drags already applied).
  Commands notify typed channels (`scene`, `selection`, `transform`, `material`, `edit`, …). React components
  subscribe with `useEditorChannels`, so the UI re-renders only for relevant changes.
- The `Viewport` subscribes to the same channels and renders on demand (no continuous render loop work when
  idle). It is created once per mounted editor and fully disposed on close.
- `ProjectSession` listens for `history` changes, debounces, serializes, and saves a new version.

## Stable ids

Every object gets `userData.zinoId`. Ids are independent of names, survive save/load (native format) and are
reassigned for duplicates. They are stripped from exported deliverables.

## Undo / redo

`Command` objects store minimal state: transform commands store matrices; value commands store old/new
values; geometry commands swap whole `BufferGeometry` objects (Zino3D never mutates geometry in place, so
swapping is safe and cheap). History is bounded by entry count (100) and approximate memory (256 MB). When
entries are evicted, geometries/materials referenced only by evicted entries are disposed.

## Mesh algorithms (`engine/geometry`)

- **Canonical vertices** (`spatialHash.ts`): positions within a tolerance are clustered with a uniform spatial
  hash (cell = 4×tolerance, neighbouring cells probed only near cell borders). Greedy and order-dependent:
  chains of points each within tolerance of the next are not transitively merged. Default tolerance is
  1e-6 × bounding-box diagonal.
- **Connectivity** (`connectivity.ts`): union–find over canonical vertices of each triangle. Works for indexed
  and non-indexed meshes, and treats copies of a vertex split at UV/normal seams as connected. Coincident but
  separate surfaces that share exact positions _are_ treated as connected — use Edit Mode face selection to
  split those. Component ids are stable (order of first triangle).
- **Extraction** (`extract.ts`): builds a new indexed geometry from a triangle mask, copying raw attribute
  values (storage type and normalization preserved), morph targets, and per-triangle material assignment
  (rebuilt as contiguous groups). Used by separate, delete, flip and cleanup.
- **Merge** (`operations.ts`): bakes source transforms into the target space, flips winding for mirroring
  matrices, keeps one group per material, fills missing UVs/colors (reported) and drops attributes not shared
  by all inputs (reported).
- **Diagnostics** (`analysis.ts`): boundary (open) and non-manifold edge counts on welded positions,
  degenerate triangles, components. “Closed surface” is reported only when there are no boundary or
  non-manifold edges.
- **Wheel candidates** (`wheelDetection.ts`): ranks loose parts using bounding-box profile, rim circularity
  (angular coverage of outer vertices around the axle), relative size, ground contact along the detected up
  axis, side placement, and similar-sized siblings. Y-up is preferred; another axis is chosen only when clearly
  better. It is a heuristic with a preview and manual correction, never applied silently.
- Large meshes (≥150k triangles) compute connectivity in a Web Worker.

### Measured performance

Synthetic test: four UV spheres merged into one mesh, 996,000 triangles, Node 22 in the development container
(single thread, no GPU). Times are indicative only; phones and tablets will be slower.

| Operation                                                                | Time    |
| ------------------------------------------------------------------------ | ------- |
| Connected components (weld + union–find)                                 | ~0.53 s |
| Separate into 4 objects (attribute-preserving extraction)                | ~0.17 s |
| Full diagnostics (components, open/non-manifold edges, degenerate faces) | ~0.98 s |

The inspector analyzes meshes automatically up to 250k triangles and offers a button above that.

## Native project format

Projects are stored as a versioned **scene document** (structured JSON-like data) plus **binary assets**
(raw typed-array buffers for geometry and PNG bytes for images), never base64.

- `schema.ts` — `SceneDocument` (schemaVersion, nodes tree, geometries, materials, textures, images, editor
  state), `validateSceneDocument`, and a `migrations` table keyed by source version.
- `sceneSerializer.ts` — serializes nodes (mesh, instanced mesh, lines, points, lights, cameras, groups),
  geometry attributes/index/groups/morph targets, materials (generic property capture for all standard
  three.js material types), textures and images. An `AssetCache` remembers which attribute/image buffers were
  already stored, so an autosave after a transform edit writes only a few KB.
- IndexedDB stores: `projects` (metadata, thumbnail, version list, asset sizes), `documents`
  (one per version), `assets` (binary, indexed by project). Saves are one atomic transaction that also
  garbage-collects assets no longer referenced by any retained version.
- Retention: latest version + up to 4 backups spaced ≥ 5 minutes apart (+ always the previous save).
- `.zino3d` bundle: `ZINO3D\0\1` + JSON manifest + concatenated binary assets — a portable single-file copy.

Native projects (lossless editing state) are distinct from exported deliverables (GLB/glTF/OBJ/STL).
