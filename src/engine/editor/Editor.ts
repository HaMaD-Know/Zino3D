import {
  type BufferGeometry,
  Group,
  type Material,
  type Mesh,
  type Object3D,
  Scene,
  type Texture,
  Vector3,
} from 'three';
import { CommandHistory } from '../history/CommandHistory';
import type { Command } from '../history/Command';
import type { CommandHost, EditorChannel } from '../history/commands/types';
import {
  ROOT_ID,
  UD,
  assignIds,
  collectResources,
  getId,
  isMesh,
  materialTextures,
} from '../scene/objectUtils';
import {
  type ElementMode,
  type ElementSelection,
  convertSelection,
  emptyElementSelection,
  getTopology,
} from '../geometry/topology';
import { Emitter } from '../../utils/emitter';

export type EditorMode = 'object' | 'edit';
export type TransformTool = 'select' | 'translate' | 'rotate' | 'scale' | 'cursor';
export type TransformSpace = 'world' | 'local';

export interface EditorSettings {
  tool: TransformTool;
  space: TransformSpace;
  snapEnabled: boolean;
  translateSnap: number;
  rotateSnapDeg: number;
  scaleSnap: number;
}

export interface EditorMessage {
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

type Events = {
  change: EditorChannel[];
  message: EditorMessage;
};

const ALL_CHANNELS: EditorChannel[] = [
  'scene',
  'selection',
  'transform',
  'history',
  'mode',
  'material',
  'settings',
  'edit',
  'status',
];

/**
 * Framework-independent editor state: content scene, stable object ids, selection, modes and history.
 * The React UI subscribes through `subscribe`; the viewport renders `scene`.
 */
export class Editor implements CommandHost {
  /** Render root (contains the content root plus editor lighting added by the viewport). */
  readonly scene = new Scene();
  /** Content root: everything the user edits, exports and saves lives under this group. */
  readonly root = new Group();
  readonly history: CommandHistory;
  readonly cursor = new Vector3();
  readonly settings: EditorSettings = {
    tool: 'translate',
    space: 'world',
    snapEnabled: false,
    translateSnap: 0.1,
    rotateSnapDeg: 15,
    scaleSnap: 0.1,
  };

  selection: string[] = [];
  mode: EditorMode = 'object';
  elementMode: ElementMode = 'face';
  editTargetId: string | null = null;
  elementSelection: ElementSelection = emptyElementSelection();
  /** Increments on every change to document content (used for dirty tracking / autosave). */
  contentRevision = 0;
  /** Busy indicator text for long-running operations. */
  busy: string | null = null;

  private readonly emitter = new Emitter<Events>();
  private readonly versions = new Map<EditorChannel, number>();
  private index = new Map<string, Object3D>();
  private batchDepth = 0;
  private pending = new Set<EditorChannel>();
  private disposed = false;

  constructor() {
    this.root.name = 'Scene';
    this.root.userData[UD.id] = ROOT_ID;
    this.scene.add(this.root);
    this.history = new CommandHistory({ onEvict: (evicted) => this.disposeEvicted(evicted) });
    this.structureChanged();
  }

  // ----- ids and lookup -------------------------------------------------------------------------

  getObject(id: string): Object3D | undefined {
    return this.index.get(id);
  }

  structureChanged(): void {
    const index = new Map<string, Object3D>();
    const taken = new Set<string>();
    this.root.traverse((o) => {
      const id = o.userData[UD.id];
      if (typeof id !== 'string' || taken.has(id)) assignIds(o, 'missing', taken);
      taken.add(o.userData[UD.id] as string);
      index.set(o.userData[UD.id] as string, o);
    });
    this.index = index;
    // Drop selection entries that no longer exist.
    const filtered = this.selection.filter((id) => index.has(id) && id !== ROOT_ID);
    if (filtered.length !== this.selection.length) {
      this.selection = filtered;
      this.notify('selection');
    }
    if (this.editTargetId && !index.has(this.editTargetId)) this.exitEditMode();
  }

  allIds(): string[] {
    return [...this.index.keys()].filter((id) => id !== ROOT_ID);
  }

  /** Locked state is inherited from ancestors. */
  isLocked(object: Object3D): boolean {
    let o: Object3D | null = object;
    while (o && o !== this.root) {
      if (o.userData[UD.locked] === true) return true;
      o = o.parent;
    }
    return false;
  }

  isEffectivelyVisible(object: Object3D): boolean {
    let o: Object3D | null = object;
    while (o && o !== this.root) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }

  // ----- events ---------------------------------------------------------------------------------

  subscribe(listener: (channels: EditorChannel[]) => void): () => void {
    return this.emitter.on('change', listener);
  }

  onMessage(listener: (message: EditorMessage) => void): () => void {
    return this.emitter.on('message', listener);
  }

  message(kind: EditorMessage['kind'], text: string): void {
    this.emitter.emit('message', { kind, text });
  }

  version(channel: EditorChannel): number {
    return this.versions.get(channel) ?? 0;
  }

  notify(...channels: EditorChannel[]): void {
    if (this.disposed) return;
    const list = channels.length ? channels : ALL_CHANNELS;
    for (const c of list) {
      this.versions.set(c, (this.versions.get(c) ?? 0) + 1);
      this.pending.add(c);
    }
    if (this.batchDepth === 0) this.flush();
  }

  /** Groups notifications from several operations into one change event. */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) this.flush();
    }
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const channels = [...this.pending];
    this.pending.clear();
    this.emitter.emit('change', channels);
  }

  // ----- history --------------------------------------------------------------------------------

  /** Executes a command and records it for undo. */
  execute(command: Command): void {
    this.batch(() => {
      command.execute();
      this.history.push(command);
      this.contentChanged();
    });
  }

  /** Records a command whose effect has already been applied (e.g. after a gizmo drag). */
  record(command: Command): void {
    this.batch(() => {
      this.history.push(command);
      this.contentChanged();
    });
  }

  undo(): void {
    if (this.busy) return;
    this.batch(() => {
      const c = this.history.undo();
      if (c) {
        this.contentChanged();
        this.message('info', `Undo: ${c.label}`);
      }
    });
  }

  redo(): void {
    if (this.busy) return;
    this.batch(() => {
      const c = this.history.redo();
      if (c) {
        this.contentChanged();
        this.message('info', `Redo: ${c.label}`);
      }
    });
  }

  private contentChanged(): void {
    this.contentRevision++;
    this.validateEditState();
    this.notify('history');
  }

  setBusy(text: string | null): void {
    this.busy = text;
    this.notify('status');
  }

  // ----- selection ------------------------------------------------------------------------------

  select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    const valid = ids.filter((id) => this.index.has(id) && id !== ROOT_ID);
    let next: string[];
    if (mode === 'replace') next = [...new Set(valid)];
    else if (mode === 'add') next = [...this.selection.filter((id) => !valid.includes(id)), ...valid];
    else {
      next = [...this.selection];
      for (const id of valid) {
        const i = next.indexOf(id);
        if (i >= 0) next.splice(i, 1);
        else next.push(id);
      }
    }
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
    this.selection = next;
    this.notify('selection');
  }

  clearSelection(): void {
    this.select([]);
  }

  selectAll(): void {
    this.select(
      this.root.children
        .flatMap((c) => this.subtreeIds(c))
        .filter((id) => {
          const o = this.index.get(id);
          return !!o && this.isEffectivelyVisible(o);
        }),
    );
  }

  invertSelection(): void {
    const current = new Set(this.selection);
    this.select(
      this.allIds().filter((id) => !current.has(id) && this.isEffectivelyVisible(this.index.get(id)!)),
    );
  }

  subtreeIds(object: Object3D): string[] {
    const ids: string[] = [];
    object.traverse((o) => ids.push(getId(o)));
    return ids;
  }

  selectedObjects(): Object3D[] {
    return this.selection.map((id) => this.index.get(id)).filter((o): o is Object3D => !!o);
  }

  activeObject(): Object3D | null {
    const id = this.selection.at(-1);
    return id ? (this.index.get(id) ?? null) : null;
  }

  /** Selected objects without descendants of other selected objects, in selection order. */
  topLevelSelection(): Object3D[] {
    const objects = this.selectedObjects();
    const set = new Set(objects);
    return objects.filter((o) => {
      let p = o.parent;
      while (p) {
        if (set.has(p)) return false;
        p = p.parent;
      }
      return true;
    });
  }

  // ----- settings -------------------------------------------------------------------------------

  updateSettings(patch: Partial<EditorSettings>): void {
    Object.assign(this.settings, patch);
    this.notify('settings');
  }

  setCursor(position: Vector3): void {
    this.cursor.copy(position);
    this.notify('settings');
  }

  // ----- edit mode ------------------------------------------------------------------------------

  editTarget(): Mesh | null {
    if (!this.editTargetId) return null;
    const o = this.index.get(this.editTargetId);
    return isMesh(o) ? o : null;
  }

  enterEditMode(): boolean {
    const active = this.activeObject();
    if (!isMesh(active)) {
      this.message('warning', 'Select a mesh object to enter Edit Mode.');
      return false;
    }
    if (this.isLocked(active)) {
      this.message('warning', `"${active.name || 'Object'}" is locked.`);
      return false;
    }
    if ((active as { isSkinnedMesh?: boolean }).isSkinnedMesh) {
      this.message('warning', 'Skinned meshes cannot be edited in Edit Mode yet.');
      return false;
    }
    this.mode = 'edit';
    this.editTargetId = getId(active);
    this.elementSelection = emptyElementSelection();
    this.select([this.editTargetId]);
    this.notify('mode', 'edit');
    return true;
  }

  exitEditMode(): void {
    if (this.mode === 'object' && !this.editTargetId) return;
    this.mode = 'object';
    this.editTargetId = null;
    this.elementSelection = emptyElementSelection();
    this.notify('mode', 'edit');
  }

  setElementMode(mode: ElementMode): void {
    if (mode === this.elementMode) return;
    const target = this.editTarget();
    if (target) {
      this.elementSelection = convertSelection(
        getTopology(target.geometry),
        this.elementMode,
        mode,
        this.elementSelection,
      );
    }
    this.elementMode = mode;
    this.notify('mode', 'edit');
  }

  setElementSelection(selection: ElementSelection): void {
    this.elementSelection = selection;
    this.notify('edit');
  }

  /** After undo/redo the edit target's geometry may change, invalidating element indices. */
  private validateEditState(): void {
    const target = this.editTarget();
    if (this.mode === 'edit' && !target) {
      this.exitEditMode();
      return;
    }
    if (target) {
      const topo = getTopology(target.geometry);
      const sel = this.elementSelection;
      const validFaces = [...sel.faces].filter((f) => f < topo.triangleCount);
      const validVerts = [...sel.vertices].filter((v) => v < topo.connectivity.canonicalCount);
      const validEdges = [...sel.edges].filter((key) =>
        key.split('_').every((v) => Number(v) < topo.connectivity.canonicalCount),
      );
      if (
        validFaces.length !== sel.faces.size ||
        validVerts.length !== sel.vertices.size ||
        validEdges.length !== sel.edges.size
      ) {
        this.elementSelection = emptyElementSelection();
        this.notify('edit');
      }
    }
  }

  // ----- resources ------------------------------------------------------------------------------

  private liveResources(): { geometries: Set<BufferGeometry>; materials: Set<Material> } {
    const live = { geometries: new Set<BufferGeometry>(), materials: new Set<Material>() };
    collectResources(this.root, live);
    for (const c of this.history.retained()) {
      const r = c.resources?.();
      if (!r) continue;
      for (const g of r.geometries) live.geometries.add(g);
      for (const m of r.materials) live.materials.add(m);
    }
    return live;
  }

  /** Disposes GPU resources referenced only by evicted history entries. */
  private disposeEvicted(evicted: Command[]): void {
    const live = this.liveResources();
    const liveTextures = new Set<Texture>();
    for (const m of live.materials) for (const t of materialTextures(m)) liveTextures.add(t);
    for (const c of evicted) {
      const r = c.resources?.();
      if (!r) continue;
      for (const g of r.geometries) if (!live.geometries.has(g)) g.dispose();
      for (const m of r.materials) {
        if (live.materials.has(m)) continue;
        for (const t of materialTextures(m)) if (!liveTextures.has(t)) t.dispose();
        m.dispose();
      }
    }
  }

  /** Releases every GPU resource owned by the document and its history. */
  dispose(): void {
    const live = this.liveResources();
    for (const g of live.geometries) g.dispose();
    for (const m of live.materials) {
      for (const t of materialTextures(m)) t.dispose();
      m.dispose();
    }
    this.disposed = true;
    this.emitter.clear();
  }

  /** Replaces the whole document (used when loading a project). Clears history. */
  loadContent(objects: Object3D[]): void {
    const previous = [...this.root.children];
    const old = { geometries: new Set<BufferGeometry>(), materials: new Set<Material>() };
    for (const o of previous) collectResources(o, old);
    for (const o of previous) o.removeFromParent();
    this.history.clear();
    const keep = { geometries: new Set<BufferGeometry>(), materials: new Set<Material>() };
    for (const o of objects) collectResources(o, keep);
    for (const g of old.geometries) if (!keep.geometries.has(g)) g.dispose();
    for (const m of old.materials) if (!keep.materials.has(m)) m.dispose();
    for (const o of objects) this.root.add(o);
    this.selection = [];
    this.mode = 'object';
    this.editTargetId = null;
    this.elementSelection = emptyElementSelection();
    this.structureChanged();
    this.notify();
  }
}
