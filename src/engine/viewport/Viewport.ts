import {
  AmbientLight,
  Box3,
  Box3Helper,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  NeutralToneMapping,
  Object3D,
  OrthographicCamera,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  SRGBColorSpace,
  Scene,
  ShadowMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Texture,
  Timer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Editor } from '../editor/Editor';
import type { EditorChannel } from '../history/commands/types';
import { TransformCommand, type TransformEntry } from '../history/commands/TransformCommand';
import { getId, hasGeometry, isMesh, setLocalMatrix, worldBounds } from '../scene/objectUtils';
import {
  type ElementSelection,
  edgeKey,
  emptyElementSelection,
  getTopology,
  selectionToTriangleMask,
  triangleCanonical,
} from '../geometry/topology';
import { translateElements } from '../editor/meshOperations';
import { EditOverlay } from './EditOverlay';
import { ZinoError } from '../../utils/errors';
import { DEG2RAD } from '../../utils/math';

export interface ViewportOptions {
  antialias: boolean;
  maxPixelRatio: number;
  shadows: boolean;
  environment: boolean;
  showGrid: boolean;
}

export const DEFAULT_VIEWPORT_OPTIONS: ViewportOptions = {
  antialias: true,
  maxPixelRatio: 2,
  shadows: false,
  environment: true,
  showGrid: true,
};

export type Projection = 'perspective' | 'orthographic';
export type NamedView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface CameraState {
  position: number[];
  target: number[];
  projection: Projection;
}

export interface ViewportDiagnostics {
  webgl: string;
  gpu: string;
  maxTextureSize: number;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  gpuGeometries: number;
  gpuTextures: number;
  canvas: string;
}

export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

const TAP_DISTANCE = 6;
const TAP_TIME = 500;

/**
 * Owns the WebGL renderer, cameras, controls, gizmos and overlays for one editor instance.
 * Created once per mounted viewport element and disposed when the editor closes.
 */
export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly helperScene = new Scene();
  readonly perspective = new PerspectiveCamera(50, 1, 0.01, 2000);
  readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  camera: PerspectiveCamera | OrthographicCamera = this.perspective;
  readonly controls: OrbitControls;
  readonly transform: TransformControls;
  /** When true, taps add to / toggle the selection (touch devices have no Shift key). */
  additive = false;
  onContextLost?: (lost: boolean) => void;

  private readonly viewHelper: ViewHelper;
  private readonly editOverlay = new EditOverlay();
  private readonly raycaster = new Raycaster();
  private readonly timer = new Timer();
  private readonly lights = new Group();
  private readonly shadowCatcher: Mesh;
  private grid: GridHelper | null = null;
  private axes: LineSegments | null = null;
  private readonly cursorMarker: LineSegments;
  private readonly selectionHelpers = new Group();
  private readonly pivot = new Object3D();
  private envTexture: Texture | null = null;
  private needsRender = true;
  private helpersDirty = true;
  private overlayDirty = true;
  private dragStart: { entries: Map<string, Matrix4>; pivot: Matrix4; worlds: Map<string, Matrix4> } | null =
    null;
  private suppressTap = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; time: number; multi: boolean } | null = null;
  private resizeObserver: ResizeObserver;
  private unsubscribe: () => void;
  private disposed = false;
  private sceneScale = 1;

  constructor(
    private readonly editor: Editor,
    private readonly container: HTMLElement,
    private options: ViewportOptions = DEFAULT_VIEWPORT_OPTIONS,
  ) {
    if (!isWebGLAvailable()) {
      throw new ZinoError(
        'webgl/unavailable',
        'WebGL is not available on this device or browser, so the 3D viewport cannot start. Try enabling hardware acceleration or using a newer browser.',
      );
    }
    this.renderer = new WebGLRenderer({
      antialias: options.antialias,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(new Color(0x1d1f23), 1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.domElement.className = 'viewport-canvas';
    this.renderer.domElement.setAttribute('aria-label', '3D viewport');
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.perspective.position.set(4, 3, 6);
    this.orthographic.position.copy(this.perspective.position);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.transform.addEventListener('change', () => this.requestRender());
    this.transform.addEventListener('mouseDown', () => this.onGizmoStart());
    this.transform.addEventListener('objectChange', () => this.onGizmoChange());
    this.transform.addEventListener('mouseUp', () => this.onGizmoEnd());
    this.helperScene.add(this.transform.getHelper());
    this.helperScene.add(this.pivot);
    this.helperScene.add(this.selectionHelpers);
    this.helperScene.add(this.editOverlay.group);

    this.viewHelper = new ViewHelper(this.camera, this.renderer.domElement);
    this.viewHelper.setLabels('X', 'Y', 'Z');

    // Lighting lives in the render scene but outside the content root: never exported or saved.
    this.lights.name = 'EditorLights';
    const hemi = new HemisphereLight(0xffffff, 0x3a3d44, 0.6);
    const ambient = new AmbientLight(0xffffff, 0.15);
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(5, 10, 7);
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    this.lights.add(hemi, ambient, sun, sun.target);
    editor.scene.add(this.lights);
    this.shadowCatcher = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.28 }));
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.name = 'ShadowCatcher';
    editor.scene.add(this.shadowCatcher);

    const cg = new BufferGeometry();
    cg.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1]), 3),
    );
    this.cursorMarker = new LineSegments(
      cg,
      new LineBasicMaterial({ color: 0xff5a5a, depthTest: false, transparent: true }),
    );
    this.cursorMarker.renderOrder = 20;
    this.helperScene.add(this.cursorMarker);

    this.applyOptions(options);
    this.updateGrid();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('webglcontextlost', this.onContextLostEvent);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.unsubscribe = editor.subscribe((channels) => this.onEditorChange(channels));
    this.syncGizmo();
    this.renderer.setAnimationLoop(() => this.loop());
  }

  // ----- options --------------------------------------------------------------------------------

  applyOptions(options: ViewportOptions): void {
    this.options = options;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio));
    this.renderer.shadowMap.enabled = options.shadows;
    const sun = this.lights.children.find(
      (c) => (c as DirectionalLight).isDirectionalLight,
    ) as DirectionalLight;
    sun.castShadow = options.shadows;
    this.shadowCatcher.visible = options.shadows;
    if (options.environment && !this.envTexture) {
      const pmrem = new PMREMGenerator(this.renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    this.editor.scene.environment = options.environment ? this.envTexture : null;
    this.editor.scene.environmentIntensity = 0.9;
    if (this.grid) this.grid.visible = options.showGrid;
    if (this.axes) this.axes.visible = options.showGrid;
    this.resize();
    this.requestRender();
  }

  // ----- rendering ------------------------------------------------------------------------------

  requestRender(): void {
    this.needsRender = true;
  }

  private loop(): void {
    if (this.disposed) return;
    this.timer.update();
    const delta = this.timer.getDelta();
    if (this.viewHelper.animating) {
      this.viewHelper.update(delta);
      this.needsRender = true;
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    this.render();
  }

  private render(): void {
    if (this.helpersDirty) this.updateSelectionHelpers();
    if (this.overlayDirty) this.updateEditOverlay();
    const target = this.editor.editTarget();
    if (target) this.editOverlay.follow(target);
    if (this.options.shadows) this.prepareShadows();
    const distance = this.camera.position.distanceTo(this.controls.target);
    const s = (this.camera as PerspectiveCamera).isPerspectiveCamera
      ? distance * 0.02
      : (0.04 / (this.camera as OrthographicCamera).zoom) *
        ((this.orthographic.top - this.orthographic.bottom) / 2);
    this.cursorMarker.position.copy(this.editor.cursor);
    this.cursorMarker.scale.setScalar(Math.max(s, 1e-6));
    this.renderer.clear();
    this.renderer.render(this.editor.scene, this.camera);
    this.renderer.render(this.helperScene, this.camera);
    this.viewHelper.render(this.renderer);
  }

  private prepareShadows(): void {
    this.editor.root.traverse((o) => {
      if (isMesh(o)) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const box = worldBounds(this.editor.root.children);
    if (box.isEmpty()) return;
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const radius = Math.max(size.length() / 2, 0.01);
    this.shadowCatcher.position.set(center.x, box.min.y - radius * 0.001, center.z);
    this.shadowCatcher.scale.setScalar(radius * 6);
    const sun = this.lights.children.find(
      (c) => (c as DirectionalLight).isDirectionalLight,
    ) as DirectionalLight;
    sun.position.copy(center).add(new Vector3(0.5, 1, 0.7).normalize().multiplyScalar(radius * 3));
    sun.target.position.copy(center);
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -radius * 1.5;
    cam.right = cam.top = radius * 1.5;
    cam.near = radius * 0.1;
    cam.far = radius * 8;
    cam.updateProjectionMatrix();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.requestRender();
  }

  private updateOrthoFrustum(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const distance = this.perspective.position.distanceTo(this.controls?.target ?? new Vector3());
    const halfH = Math.max(distance * Math.tan((this.perspective.fov * DEG2RAD) / 2), 1e-4);
    this.orthographic.top = halfH;
    this.orthographic.bottom = -halfH;
    this.orthographic.left = -halfH * (w / h);
    this.orthographic.right = halfH * (w / h);
    this.orthographic.near = -this.sceneScale * 500;
    this.orthographic.far = this.sceneScale * 500;
    this.orthographic.updateProjectionMatrix();
  }

  // ----- editor sync ----------------------------------------------------------------------------

  private onEditorChange(channels: EditorChannel[]): void {
    this.requestRender();
    if (this.dragStart) return; // don't fight the gizmo mid-drag
    if (channels.some((c) => c === 'selection' || c === 'scene' || c === 'transform' || c === 'mode'))
      this.helpersDirty = true;
    if (channels.some((c) => c === 'edit' || c === 'mode' || c === 'scene')) this.overlayDirty = true;
    if (
      channels.some(
        (c) =>
          c === 'selection' ||
          c === 'mode' ||
          c === 'settings' ||
          c === 'scene' ||
          c === 'edit' ||
          c === 'transform',
      )
    )
      this.syncGizmo();
    if (channels.includes('scene')) this.updateGrid();
  }

  private updateGrid(): void {
    const box = worldBounds(this.editor.root.children);
    const size = box.isEmpty() ? 10 : Math.max(box.getSize(new Vector3()).length(), 1e-3);
    const unit = 10 ** Math.floor(Math.log10(size));
    if (this.grid && Math.abs(this.sceneScale - unit) < 1e-12) return;
    this.sceneScale = unit;
    if (this.grid) {
      this.grid.removeFromParent();
      this.grid.geometry.dispose();
      (this.grid.material as LineBasicMaterial).dispose();
    }
    if (this.axes) {
      this.axes.removeFromParent();
      this.axes.geometry.dispose();
      (this.axes.material as LineBasicMaterial).dispose();
    }
    const extent = unit * 20;
    this.grid = new GridHelper(extent, 40, 0x4a4f58, 0x2f3238);
    (this.grid.material as LineBasicMaterial).transparent = true;
    (this.grid.material as LineBasicMaterial).opacity = 0.8;
    (this.grid.material as LineBasicMaterial).depthWrite = false;
    this.grid.visible = this.options.showGrid;
    this.helperScene.add(this.grid);
    const half = extent / 2;
    const ag = new BufferGeometry();
    ag.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-half, 0, 0, half, 0, 0, 0, 0, -half, 0, 0, half]), 3),
    );
    ag.setAttribute(
      'color',
      new BufferAttribute(
        new Float32Array([0.85, 0.25, 0.25, 0.85, 0.25, 0.25, 0.25, 0.45, 0.9, 0.25, 0.45, 0.9]),
        3,
      ),
    );
    this.axes = new LineSegments(
      ag,
      new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
    );
    this.axes.visible = this.options.showGrid;
    this.helperScene.add(this.axes);
    this.perspective.near = unit / 1000;
    this.perspective.far = unit * 5000;
    this.perspective.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateSelectionHelpers(): void {
    this.helpersDirty = false;
    for (const c of [...this.selectionHelpers.children]) {
      c.removeFromParent();
      (c as Box3Helper).geometry.dispose();
      ((c as Box3Helper).material as LineBasicMaterial).dispose();
    }
    if (this.editor.mode === 'edit') return;
    const active = this.editor.activeObject();
    for (const o of this.editor.selectedObjects()) {
      if (!this.editor.isEffectivelyVisible(o)) continue;
      const box = worldBounds([o]);
      if (box.isEmpty()) {
        const p = new Vector3().setFromMatrixPosition(o.matrixWorld);
        box.setFromCenterAndSize(p, new Vector3().setScalar(this.sceneScale * 0.05));
      }
      const helper = new Box3Helper(box, new Color(o === active ? 0xffa53a : 0xd0782a));
      (helper.material as LineBasicMaterial).depthTest = false;
      (helper.material as LineBasicMaterial).transparent = true;
      helper.renderOrder = 5;
      this.selectionHelpers.add(helper);
    }
  }

  private updateEditOverlay(): void {
    this.overlayDirty = false;
    const target = this.editor.editTarget();
    if (!target) {
      this.editOverlay.setTopology(null, this.editor.elementMode);
      this.editOverlay.setSelection(this.editor.elementMode, emptyElementSelection());
      return;
    }
    const topo = getTopology(target.geometry);
    this.editOverlay.setTopology(topo, this.editor.elementMode);
    this.editOverlay.setSelection(this.editor.elementMode, this.editor.elementSelection);
  }

  // ----- gizmo ----------------------------------------------------------------------------------

  private syncGizmo(): void {
    const s = this.editor.settings;
    this.transform.setSpace(s.space);
    this.transform.setTranslationSnap(s.snapEnabled ? s.translateSnap : null);
    this.transform.setRotationSnap(s.snapEnabled ? s.rotateSnapDeg * DEG2RAD : null);
    this.transform.setScaleSnap(s.snapEnabled ? s.scaleSnap : null);
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    this.transform.size = coarse ? 1.5 : 1;
    const tool = s.tool;
    if (tool !== 'translate' && tool !== 'rotate' && tool !== 'scale') {
      this.transform.detach();
      return;
    }
    if (this.editor.mode === 'edit') {
      const center = this.elementSelectionCenter();
      if (!center || tool !== 'translate') {
        this.transform.detach();
        return;
      }
      this.pivot.position.copy(center);
      this.pivot.quaternion.identity();
      this.pivot.scale.set(1, 1, 1);
      this.pivot.updateMatrixWorld(true);
      this.transform.setMode('translate');
      this.transform.attach(this.pivot);
      return;
    }
    const objects = this.editor
      .topLevelSelection()
      .filter((o) => !this.editor.isLocked(o) && this.editor.isEffectivelyVisible(o));
    if (objects.length === 0) {
      this.transform.detach();
      return;
    }
    this.transform.setMode(tool);
    if (objects.length === 1) {
      this.transform.attach(objects[0]);
    } else {
      const box = worldBounds(objects);
      this.pivot.position.copy(box.isEmpty() ? new Vector3() : box.getCenter(new Vector3()));
      this.pivot.quaternion.identity();
      this.pivot.scale.set(1, 1, 1);
      this.pivot.updateMatrixWorld(true);
      this.transform.attach(this.pivot);
    }
  }

  private elementSelectionCenter(): Vector3 | null {
    const target = this.editor.editTarget();
    if (!target) return null;
    const topo = getTopology(target.geometry);
    const ids = new Set<number>();
    const sel = this.editor.elementSelection;
    if (this.editor.elementMode === 'vertex') sel.vertices.forEach((v) => ids.add(v));
    else if (this.editor.elementMode === 'edge')
      sel.edges.forEach((k) => k.split('_').forEach((v) => ids.add(Number(v))));
    else {
      const mask = selectionToTriangleMask(topo, 'face', sel, 'contained');
      for (let t = 0; t < mask.length; t++)
        if (mask[t]) triangleCanonical(topo, t).forEach((v) => ids.add(v));
    }
    if (ids.size === 0) return null;
    const c = new Vector3();
    const p = topo.canonicalPositions;
    for (const v of ids) c.add(new Vector3(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]));
    c.divideScalar(ids.size);
    target.updateWorldMatrix(true, false);
    return c.applyMatrix4(target.matrixWorld);
  }

  private onGizmoStart(): void {
    const entries = new Map<string, Matrix4>();
    const worlds = new Map<string, Matrix4>();
    if (this.editor.mode === 'object') {
      for (const o of this.editor.topLevelSelection()) {
        if (this.editor.isLocked(o)) continue;
        o.updateMatrix();
        o.updateWorldMatrix(true, false);
        entries.set(getId(o), o.matrix.clone());
        worlds.set(getId(o), o.matrixWorld.clone());
      }
    }
    this.pivot.updateMatrixWorld(true);
    this.dragStart = { entries, worlds, pivot: this.pivot.matrixWorld.clone() };
  }

  private onGizmoChange(): void {
    const start = this.dragStart;
    if (!start || this.editor.mode !== 'object') return;
    if (this.transform.object === this.pivot) {
      this.pivot.updateMatrixWorld(true);
      const delta = new Matrix4().multiplyMatrices(
        this.pivot.matrixWorld,
        new Matrix4().copy(start.pivot).invert(),
      );
      for (const [id, world] of start.worlds) {
        const o = this.editor.getObject(id);
        if (!o || !o.parent) continue;
        o.parent.updateWorldMatrix(true, false);
        const local = new Matrix4()
          .copy(o.parent.matrixWorld)
          .invert()
          .multiply(delta.clone().multiply(world));
        setLocalMatrix(o, local);
      }
    }
    this.editor.notify('transform');
  }

  private onGizmoEnd(): void {
    const start = this.dragStart;
    this.dragStart = null;
    this.suppressTap = true;
    if (!start) return;
    if (this.editor.mode === 'edit') {
      this.pivot.updateMatrixWorld(true);
      const target = this.editor.editTarget();
      const from = new Vector3().setFromMatrixPosition(start.pivot);
      const to = new Vector3().setFromMatrixPosition(this.pivot.matrixWorld);
      if (target && from.distanceToSquared(to) > 0) {
        target.updateWorldMatrix(true, false);
        const inv = new Matrix4().copy(target.matrixWorld).invert();
        const offset = to.clone().applyMatrix4(inv).sub(from.clone().applyMatrix4(inv));
        translateElements(this.editor, offset);
      }
      this.syncGizmo();
      return;
    }
    const entries: TransformEntry[] = [];
    for (const [id, before] of start.entries) {
      const o = this.editor.getObject(id);
      if (!o) continue;
      o.updateMatrix();
      if (!o.matrix.equals(before)) entries.push({ id, before, after: o.matrix.clone() });
    }
    if (entries.length) {
      const mode = this.transform.getMode();
      const label = mode === 'translate' ? 'Move' : mode === 'rotate' ? 'Rotate' : 'Scale';
      this.editor.record(new TransformCommand(this.editor, entries, `${label} ${entries.length} object(s)`));
    }
    this.helpersDirty = true;
    this.syncGizmo();
  }

  // ----- picking --------------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.down = { x: e.clientX, y: e.clientY, time: performance.now(), multi: false };
      this.suppressTap = false;
    } else if (this.down) this.down.multi = true;
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.down = null;
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    const down = this.down;
    if (this.pointers.size === 0) this.down = null;
    if (!down || down.multi || this.suppressTap || this.transform.dragging) return;
    if (
      Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_DISTANCE ||
      performance.now() - down.time > TAP_TIME
    )
      return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (this.viewHelper.handleClick(e)) {
      this.requestRender();
      return;
    }
    this.handleTap(e);
  };

  private ndc(e: { clientX: number; clientY: number }): Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private pickables(): Object3D[] {
    const out: Object3D[] = [];
    this.editor.root.traverseVisible((o) => {
      if (hasGeometry(o)) out.push(o);
    });
    return out;
  }

  private handleTap(e: PointerEvent): void {
    const additive = this.additive || e.shiftKey || e.ctrlKey || e.metaKey;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    this.raycaster.params.Points = { threshold: this.sceneScale * 0.02 };
    this.raycaster.params.Line = { threshold: this.sceneScale * 0.02 };
    const tool = this.editor.settings.tool;

    if (tool === 'cursor') {
      const hit = this.raycaster.intersectObjects(this.pickables(), false)[0];
      let point = hit?.point;
      if (!point) {
        const t = -this.raycaster.ray.origin.y / this.raycaster.ray.direction.y;
        if (Number.isFinite(t) && t > 0) point = this.raycaster.ray.at(t, new Vector3());
      }
      if (point) this.editor.setCursor(point);
      return;
    }

    if (this.editor.mode === 'edit') {
      this.handleEditTap(additive);
      return;
    }
    const hit = this.raycaster.intersectObjects(this.pickables(), false)[0];
    if (!hit) {
      if (!additive) this.editor.clearSelection();
      return;
    }
    this.editor.select([getId(hit.object)], additive ? 'toggle' : 'replace');
  }

  private handleEditTap(additive: boolean): void {
    const target = this.editor.editTarget();
    if (!target) return;
    const hit: Intersection | undefined = this.raycaster.intersectObject(target, false)[0];
    const current = this.editor.elementSelection;
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) {
      if (!additive) this.editor.setElementSelection(emptyElementSelection());
      return;
    }
    const topo = getTopology(target.geometry);
    const t = hit.faceIndex;
    target.updateWorldMatrix(true, false);
    const local = hit.point.clone().applyMatrix4(new Matrix4().copy(target.matrixWorld).invert());
    const p = topo.canonicalPositions;
    const pos = (v: number) => new Vector3(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
    const next: ElementSelection = additive
      ? { vertices: new Set(current.vertices), edges: new Set(current.edges), faces: new Set(current.faces) }
      : emptyElementSelection();
    const toggle = <T>(set: Set<T>, v: T) => {
      if (additive && set.has(v)) set.delete(v);
      else set.add(v);
    };
    const [a, b, c] = triangleCanonical(topo, t);
    if (this.editor.elementMode === 'face') toggle(next.faces, t);
    else if (this.editor.elementMode === 'vertex') {
      const best = [a, b, c].sort(
        (x, y) => pos(x).distanceToSquared(local) - pos(y).distanceToSquared(local),
      )[0];
      toggle(next.vertices, best);
    } else {
      const segDist = (x: number, y: number) => {
        const A = pos(x),
          B = pos(y);
        const ab = B.clone().sub(A);
        const tt = Math.max(0, Math.min(1, local.clone().sub(A).dot(ab) / Math.max(ab.lengthSq(), 1e-20)));
        return A.add(ab.multiplyScalar(tt)).distanceToSquared(local);
      };
      const edges: Array<[number, number]> = [
        [a, b],
        [b, c],
        [c, a],
      ];
      edges.sort((e1, e2) => segDist(e1[0], e1[1]) - segDist(e2[0], e2[1]));
      toggle(next.edges, edgeKey(edges[0][0], edges[0][1]));
    }
    this.editor.setElementSelection(next);
  }

  // ----- camera ---------------------------------------------------------------------------------

  setProjection(projection: Projection): void {
    const from = this.camera;
    const to = projection === 'perspective' ? this.perspective : this.orthographic;
    if (from === to) return;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    if (projection === 'orthographic') {
      // Match the perspective view's framing at the orbit target.
      this.perspective.position.copy(from.position);
      this.orthographic.zoom = 1;
      this.updateOrthoFrustum();
    } else {
      const ortho = from as OrthographicCamera;
      const halfH = (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      const distance = halfH / Math.tan((this.perspective.fov * DEG2RAD) / 2);
      const dir = new Vector3().subVectors(from.position, this.controls.target).normalize();
      to.position.copy(this.controls.target).addScaledVector(dir, distance);
    }
    this.camera = to;
    this.controls.object = to;
    this.transform.camera = to;
    (this.viewHelper as unknown as { camera: PerspectiveCamera | OrthographicCamera }).camera = to;
    this.controls.update();
    this.requestRender();
  }

  get projection(): Projection {
    return this.camera === this.perspective ? 'perspective' : 'orthographic';
  }

  setView(view: NamedView): void {
    const dirs: Record<NamedView, Vector3> = {
      front: new Vector3(0, 0, 1),
      back: new Vector3(0, 0, -1),
      left: new Vector3(-1, 0, 0),
      right: new Vector3(1, 0, 0),
      top: new Vector3(0, 1, 0.0001),
      bottom: new Vector3(0, -1, 0.0001),
    };
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(dirs[view].normalize(), distance);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.requestRender();
  }

  /** Frames the given objects (or everything). Never modifies geometry. */
  frame(objects?: Object3D[]): void {
    const list = objects && objects.length ? objects : this.editor.root.children;
    const box = worldBounds(list.filter((o) => this.editor.isEffectivelyVisible(o)));
    if (box.isEmpty()) {
      if (objects?.length)
        box.setFromCenterAndSize(
          new Vector3().setFromMatrixPosition(objects[0].matrixWorld),
          new Vector3(1, 1, 1),
        );
      else box.setFromCenterAndSize(new Vector3(), new Vector3(4, 4, 4));
    }
    this.frameBox(box);
  }

  private frameBox(box: Box3): void {
    const center = box.getCenter(new Vector3());
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1e-4);
    const dir = new Vector3().subVectors(this.camera.position, this.controls.target);
    if (dir.lengthSq() < 1e-12) dir.set(1, 0.7, 1.4);
    dir.normalize();
    const distance = (radius / Math.sin((this.perspective.fov * DEG2RAD) / 2)) * 1.15;
    this.controls.target.copy(center);
    this.perspective.position.copy(center).addScaledVector(dir, distance);
    this.perspective.near = Math.max(distance / 1000, radius / 10000);
    this.perspective.far = Math.max(distance * 100, radius * 100);
    this.perspective.updateProjectionMatrix();
    if (this.camera === this.orthographic) {
      this.orthographic.position.copy(this.perspective.position);
      this.orthographic.zoom = 1;
      this.updateOrthoFrustum();
    } else this.updateOrthoFrustum();
    this.viewHelper.center.copy(center);
    this.controls.update();
    this.requestRender();
  }

  getCameraState(): CameraState {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      projection: this.projection,
    };
  }

  setCameraState(state: CameraState): void {
    this.setProjection(state.projection);
    this.camera.position.fromArray(state.position);
    this.controls.target.fromArray(state.target);
    this.viewHelper.center.copy(this.controls.target);
    this.controls.update();
    this.requestRender();
  }

  // ----- utilities ------------------------------------------------------------------------------

  /** Renders the content only (no helpers) and returns a small JPEG thumbnail. */
  async captureThumbnail(width = 320, height = 240): Promise<{ data: ArrayBuffer; type: string } | null> {
    try {
      this.renderer.clear();
      this.renderer.render(this.editor.scene, this.camera);
      const src = this.renderer.domElement;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#1d1f23';
      ctx.fillRect(0, 0, width, height);
      const scale = Math.max(width / src.width, height / src.height);
      const w = src.width * scale,
        h = src.height * scale;
      ctx.drawImage(src, (width - w) / 2, (height - h) / 2, w, h);
      this.requestRender();
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      return blob ? { data: await blob.arrayBuffer(), type: 'image/jpeg' } : null;
    } catch {
      return null;
    }
  }

  diagnostics(): ViewportDiagnostics {
    const gl = this.renderer.getContext();
    let gpu: string;
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    } catch {
      gpu = 'unavailable';
    }
    const info = this.renderer.info;
    return {
      webgl: this.renderer.capabilities.isWebGL2 ? 'WebGL 2' : 'WebGL 1',
      gpu,
      maxTextureSize: this.renderer.capabilities.maxTextureSize,
      pixelRatio: this.renderer.getPixelRatio(),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      gpuGeometries: info.memory.geometries,
      gpuTextures: info.memory.textures,
      canvas: `${this.renderer.domElement.width}×${this.renderer.domElement.height}`,
    };
  }

  private onContextLostEvent = (e: Event): void => {
    e.preventDefault();
    this.onContextLost?.(true);
  };

  private onContextRestored = (): void => {
    this.onContextLost?.(false);
    this.requestRender();
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.unsubscribe();
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('webglcontextlost', this.onContextLostEvent);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.transform.detach();
    this.transform.dispose();
    this.controls.dispose();
    this.viewHelper.dispose();
    this.editOverlay.dispose();
    this.helpersDirty = false;
    for (const c of [...this.selectionHelpers.children]) (c as Box3Helper).geometry.dispose();
    this.grid?.geometry.dispose();
    this.axes?.geometry.dispose();
    this.cursorMarker.geometry.dispose();
    this.shadowCatcher.geometry.dispose();
    this.lights.removeFromParent();
    this.shadowCatcher.removeFromParent();
    this.editor.scene.environment = null;
    this.envTexture?.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}
