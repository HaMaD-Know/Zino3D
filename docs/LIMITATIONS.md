# Known limitations (v0.1)

Stated honestly so nobody relies on something that is not there.

## Editing

- Edit Mode works on triangle meshes. Element transforms support **move** only (no rotate/scale of
  selected vertices yet). There is no extrude, bevel, loop cut, knife, subdivision or sculpting.
- Selection is by tap/click (with additive mode); there is no box or lasso selection yet.
- Raycasting is brute force per pick. Very dense meshes (millions of triangles) select slowly; a BVH
  (e.g. three-mesh-bvh) is planned.
- Skinned meshes are displayed and can be transformed, but mesh editing is disabled for them. Animations,
  skins and morph-target animation are not edited and are **not** preserved in edited GLB exports or projects
  (morph target _attributes_ are kept on geometry when saving the native project).
- Connectivity treats coincident vertices as connected (within tolerance). Two surfaces that touch exactly
  at shared positions count as one part; split them with face selection.
- Wheel detection is a geometric heuristic. It handles any heading and Y- or Z-up models and groups
  multi-piece wheels (tyre + rim + hub), but may rank round non-wheel parts highly; always check the preview.
- Wheels fused into the body are separated with the tap-to-pick wheel tool, which selects faces inside an
  estimated cylinder. Body faces that lie inside that cylinder (e.g. a wheel arch touching the tyre) are
  selected too; reduce the radius/depth, or clean up afterwards in Edit Mode. The cut follows triangles, so
  the new wheel and the body may have open edges where they were joined.
- Deleting faces can leave holes; Zino3D reports open edges but does not fill holes.
- Weld merges vertices only when _all_ attributes match (keeps UV seams). There is no “merge by distance
  ignoring UVs” mode yet.

## Materials and textures

- Full editing for `MeshStandardMaterial` / `MeshPhysicalMaterial`. Legacy (Phong/Lambert/Basic) materials
  expose color/opacity/emissive and can be converted to PBR.
- No UV editor or unwrapping; UVs are preserved and their presence is reported.
- Texture replacement assumes glTF UV conventions (flipY = false) unless the slot already had a texture.
- KTX2/compressed textures load and render, but cannot be re-encoded into the native project (they are
  reported as missing after reload).

## Formats

- FBX import uses three.js `FBXLoader` and is **experimental** (binary/ASCII FBX ≥ 7.0). FBX export is not
  supported.
- OBJ export contains geometry, normals, UVs and object names only (no MTL/textures). STL contains triangles
  only.
- glTF exporter limitations apply: non-PBR material features are approximated; lights/cameras export only when
  supported by `GLTFExporter`.
- Units are not converted; STL/OBJ are assumed to be in meters.

## Storage and platform

- Projects live in the browser/WebView's IndexedDB. Browsers may evict data under storage pressure unless
  persistent storage is granted (the app requests it). Download `.zino3d` backups for important work.
- OPFS is not used yet; large binary assets are stored as ArrayBuffers in IndexedDB.
- Recovery restores the last autosave (default debounce 2 s; flushed when the app is backgrounded). Changes
  made in the last seconds before a crash can be lost.
- Native iOS/Android builds have **not** been tested on physical devices or simulators yet; the CI workflows
  are written but had not run at the time of writing. File picking and sharing inside the native WebViews
  use `<input type=file>` and the Share sheet — verify on target devices.
- Apple Pencil is supported as a standard pointer; there is no pressure-sensitive tooling.
- Desktop packaging (Tauri) is not implemented; the PWA can be installed from Chromium-based browsers.
