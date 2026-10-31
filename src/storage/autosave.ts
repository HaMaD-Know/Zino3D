import type { Editor } from '../engine/editor/Editor';
import { AssetCache, deserializeScene, serializeScene } from '../engine/serialization/sceneSerializer';
import type { EditorStateRecord } from '../engine/serialization/schema';
import type { Texture } from 'three';
import { computeSceneStats } from '../formats/sceneStats';
import { describeError } from '../utils/errors';
import { log } from '../utils/logging';
import { Emitter } from '../utils/emitter';
import type { ProjectRepository, SaveReason } from './projectRepository';
import { clearSessionMarker, writeSessionMarker } from './session';

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface SessionStatus {
  state: SaveState;
  lastSavedAt: number | null;
  error: string | null;
}

export interface ProjectSessionOptions {
  debounceMs?: number;
  captureThumbnail?: () => Promise<{ data: ArrayBuffer; type: string } | null>;
  editorState?: () => EditorStateRecord;
  decompressTexture?: (t: Texture) => Promise<Texture | null>;
}

/**
 * Connects an Editor to persistent storage: debounced autosave after meaningful changes, explicit
 * save, flush on backgrounding, and unclean-shutdown markers for recovery.
 */
export class ProjectSession {
  readonly cache = new AssetCache();
  status: SessionStatus = { state: 'saved', lastSavedAt: null, error: null };
  private savedRevision: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private again = false;
  private unsubscribe: (() => void) | null = null;
  private lastThumbnailAt = 0;
  private readonly emitter = new Emitter<{ status: SessionStatus }>();
  private readonly debounceMs: number;

  constructor(
    private readonly editor: Editor,
    readonly projectId: string,
    private projectName: string,
    private readonly repo: ProjectRepository,
    private readonly options: ProjectSessionOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 2000;
    this.savedRevision = editor.contentRevision;
  }

  get dirty(): boolean {
    return this.editor.contentRevision !== this.savedRevision;
  }

  onStatus(listener: (s: SessionStatus) => void): () => void {
    return this.emitter.on('status', listener);
  }

  private setStatus(patch: Partial<SessionStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emitter.emit('status', this.status);
    writeSessionMarker({
      projectId: this.projectId,
      projectName: this.projectName,
      openedAt: Date.now(),
      lastSavedAt: this.status.lastSavedAt,
      unsavedChanges: this.dirty,
    });
  }

  /** Loads the latest saved version into the editor. Returns warnings to show the user. */
  async load(versionId?: string): Promise<string[]> {
    const loaded = await this.repo.loadDocument(this.projectId, versionId);
    if (!loaded) {
      this.editor.loadContent([]);
      this.savedRevision = this.editor.contentRevision;
      this.setStatus({ state: 'saved', lastSavedAt: null });
      return [];
    }
    this.projectName = loaded.record.name;
    const { objects, warnings } = await deserializeScene(
      loaded.document,
      (id) => this.repo.readAsset(this.projectId, id),
      this.cache,
    );
    this.editor.loadContent(objects);
    const ed = loaded.document.editor;
    if (ed?.cursor) this.editor.cursor.fromArray(ed.cursor);
    if (ed?.settings) this.editor.updateSettings(ed.settings as Partial<Editor['settings']>);
    this.savedRevision = this.editor.contentRevision;
    this.setStatus({ state: 'saved', lastSavedAt: loaded.version.savedAt, error: null });
    return warnings;
  }

  start(): void {
    this.unsubscribe = this.editor.subscribe((channels) => {
      if (channels.includes('history') && this.dirty) this.schedule();
    });
    this.setStatus({});
  }

  rename(name: string): void {
    this.projectName = name;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.setStatus({ state: 'pending' });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save('autosave');
    }, this.debounceMs);
  }

  /** Saves immediately if there are unsaved changes (or always when `force`). */
  async save(reason: SaveReason = 'manual', force = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty && !force) {
      if (this.status.state !== 'saved' && !this.saving) this.setStatus({ state: 'saved' });
      return;
    }
    if (this.saving) {
      this.again = true;
      return this.saving;
    }
    if (this.editor.busy) {
      // Wait until the long-running operation finishes.
      this.schedule();
      return;
    }
    this.saving = this.doSave(reason).finally(() => {
      this.saving = null;
      if (this.again) {
        this.again = false;
        void this.save('autosave');
      }
    });
    return this.saving;
  }

  private async doSave(reason: SaveReason): Promise<void> {
    const revision = this.editor.contentRevision;
    this.setStatus({ state: 'saving' });
    try {
      const result = await serializeScene(this.editor.root.children, this.cache, {
        decompressTexture: this.options.decompressTexture,
      });
      result.document.editor = {
        cursor: this.editor.cursor.toArray() as [number, number, number],
        settings: { ...this.editor.settings },
        ...this.options.editorState?.(),
      };
      let thumbnail: { data: ArrayBuffer; type: string } | undefined;
      const now = Date.now();
      if (this.options.captureThumbnail && (reason !== 'autosave' || now - this.lastThumbnailAt > 20_000)) {
        thumbnail = (await this.options.captureThumbnail()) ?? undefined;
        this.lastThumbnailAt = now;
      }
      const version = await this.repo.saveVersion(this.projectId, {
        document: result.document,
        newAssets: result.newAssets,
        referencedAssets: result.referencedAssets,
        reason,
        thumbnail,
        stats: computeSceneStats(this.editor.root.children),
      });
      this.savedRevision = revision;
      for (const w of result.warnings) this.editor.message('warning', w);
      this.setStatus({ state: this.dirty ? 'pending' : 'saved', lastSavedAt: version.savedAt, error: null });
      if (this.dirty) this.schedule();
    } catch (error) {
      const message = describeError(error);
      log.error('Save failed', error);
      this.setStatus({ state: 'error', error: message });
      this.editor.message('error', `Project could not be saved: ${message}`);
    }
  }

  /** Called when the app is backgrounded or closing. */
  async flush(): Promise<void> {
    if (this.dirty || this.timer) await this.save('autosave');
    else if (this.saving) await this.saving;
  }

  /** Clean close: flush and clear the unclean-shutdown marker. */
  async close(): Promise<void> {
    await this.flush();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.emitter.clear();
    if (!this.dirty) clearSessionMarker();
  }
}
