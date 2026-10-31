// Generates the small binary test fixtures in tests/fixtures (all original, CC0 / public domain).
// Usage: node scripts/generate-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures');
mkdirSync(out, { recursive: true });

// GLTFExporter uses FileReader for binary output; provide a tiny Node implementation.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = b;
      this.onloadend?.();
      this.onload?.();
    });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
      this.onload?.();
    });
  }
};

const exporter = new GLTFExporter();
async function save(name, input) {
  const glb = await exporter.parseAsync(input, { binary: true });
  writeFileSync(resolve(out, name), Buffer.from(glb));
  console.log(`wrote ${name} (${glb.byteLength} bytes)`);
}

const mat = (name, color, metalness = 0, roughness = 0.6) => {
  const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
  m.name = name;
  return m;
};
const strip = (g) => {
  for (const k of Object.keys(g.attributes))
    if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  g.clearGroups();
  return g;
};

// 1. Simple cube
{
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat('Grey', 0x8899aa));
  cube.name = 'Cube';
  await save('cube.glb', cube);
}

// 2. Multi-mesh scene with hierarchy and transforms
{
  const root = new THREE.Group();
  root.name = 'Assembly';
  const base = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), mat('Base', 0x555555));
  base.name = 'Base';
  const arm = new THREE.Group();
  arm.name = 'Arm';
  arm.position.set(0, 0.5, 0);
  arm.rotation.set(0, Math.PI / 4, 0);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8), mat('Ball', 0xdd8833));
  sphere.name = 'Ball';
  sphere.position.set(0.8, 0.2, 0);
  sphere.scale.set(1, 2, 1);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1, 12), mat('Rod', 0xaaaaaa, 1, 0.3));
  cyl.name = 'Rod';
  arm.add(sphere, cyl);
  root.add(base, arm);
  await save('multimesh.glb', root);
}

// 3. Multiple materials on one mesh (exported as one glTF mesh with two primitives)
{
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.clearGroups();
  g.addGroup(0, 18, 0);
  g.addGroup(18, 18, 1);
  const m = new THREE.Mesh(g, [mat('Red', 0xcc2222), mat('Blue', 0x2244cc)]);
  m.name = 'TwoTone';
  await save('multi-material.glb', m);
}

// 4 & 5. Car-like single meshes (single material, like many AI-generated models)
function car(fused) {
  const body = strip(new THREE.BoxGeometry(1.8, 0.5, 4, 2, 1, 4));
  body.translate(0, 0.65, 0);
  const cabin = strip(new THREE.BoxGeometry(1.5, 0.45, 2, 1, 1, 2));
  cabin.translate(0, 1.12, -0.2);
  const parts = [body, cabin];
  for (const x of [-0.95, 0.95])
    for (const z of [-1.3, 1.3]) {
      const w = strip(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 20, 1));
      w.rotateZ(Math.PI / 2);
      w.translate(x, 0.36, z);
      parts.push(w);
    }
  const merged = mergeGeometries(parts);
  if (fused) {
    const bodyVerts = body.getAttribute('position').count + cabin.getAttribute('position').count;
    const perWheel = parts[2].getAttribute('position').count;
    const idx = Array.from(merged.index.array);
    for (let w = 0; w < 4; w++) idx.push(bodyVerts + w * perWheel, w * 4, w * 4 + 1);
    merged.setIndex(idx);
  }
  const mesh = new THREE.Mesh(merged, mat('Car', 0xc2410c, 0.5, 0.4));
  mesh.name = fused ? 'CarFused' : 'Car';
  return mesh;
}
await save('car-loose-wheels.glb', car(false));
await save('car-fused-wheels.glb', car(true));

// 6. Textured GLB written by hand (exporter needs a DOM canvas for textures)
function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
{
  const size = 8;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const on = (x + y) % 2 === 0;
      pixels.set(on ? [240, 140, 40, 255] : [40, 40, 48, 255], (y * size + x) * 4);
    }
  const image = png(size, size, pixels);
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const views = [
    Buffer.from(positions.buffer),
    Buffer.from(normals.buffer),
    Buffer.from(uvs.buffer),
    pad4(Buffer.from(indices.buffer)),
    pad4(image),
  ];
  let offset = 0;
  const bufferViews = views.map((v, i) => {
    const bv = {
      buffer: 0,
      byteOffset: offset,
      byteLength: i === 3 ? indices.byteLength : i === 4 ? image.length : v.length,
    };
    offset += v.length;
    return bv;
  });
  const json = {
    asset: { version: '2.0', generator: 'Zino3D fixture generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'TexturedQuad', mesh: 0 }],
    meshes: [
      {
        name: 'TexturedQuad',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }],
      },
    ],
    materials: [
      {
        name: 'Checker',
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: 4, mimeType: 'image/png', name: 'checker' }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [-0.5, -0.5, 0],
        max: [0.5, 0.5, 0],
      },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(views);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const ch = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  writeFileSync(
    resolve(out, 'textured.glb'),
    Buffer.concat([header, ch(jsonChunk.length, 0x4e4f534a), jsonChunk, ch(bin.length, 0x004e4942), bin]),
  );
  console.log('wrote textured.glb');

  // Multi-file variant: .gltf JSON referencing an external .bin and .png (tests multi-file import).
  const geomBin = Buffer.concat(views.slice(0, 4));
  const ext = JSON.parse(JSON.stringify(json));
  ext.buffers = [{ byteLength: geomBin.length, uri: 'textured-external.bin' }];
  ext.bufferViews = bufferViews.slice(0, 4);
  ext.images = [{ uri: 'checker.png', name: 'checker' }];
  writeFileSync(resolve(out, 'textured-external.gltf'), JSON.stringify(ext, null, 2));
  writeFileSync(resolve(out, 'textured-external.bin'), geomBin);
  writeFileSync(resolve(out, 'checker.png'), image);
  console.log('wrote textured-external.gltf/.bin + checker.png');
}

// 7. Malformed GLB (valid header, corrupted JSON) and an unsupported file
{
  const bad = Buffer.from('{"asset": {"version": "2.0"}, "nodes": [ BROKEN');
  const jsonChunk = Buffer.concat([bad, Buffer.alloc((4 - (bad.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonChunk.length, 8);
  header.writeUInt32LE(jsonChunk.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  writeFileSync(resolve(out, 'malformed.glb'), Buffer.concat([header, jsonChunk]));
  writeFileSync(resolve(out, 'unsupported.xyz'), 'this is not a 3D model\n');
  console.log('wrote malformed.glb, unsupported.xyz');
}
