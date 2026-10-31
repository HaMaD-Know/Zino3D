import { type SceneDocument, migrateSceneDocument } from '../engine/serialization/schema';
import type { SceneStats } from '../formats/sceneStats';
import { createId } from '../utils/ids';
import { ZinoError, isQuotaError } from '../utils/errors';
import { STORES, openDatabase, requestToPromise, transactionDone } from './database';
import { decodeBundle, encodeBundle } from './bundle';

export const PROJECT_RECORD_VERSION = 1;
/** Number of older versions kept as recovery backups (in addition to the latest). */
export const MAX_BACKUPS = 4;
/** Minimum age gap between kept backups, so rapid autosaves don't push out useful restore points. */
export const BACKUP_SPACING_MS = 5 * 60 * 1000;

export type SaveReason = 'autosave' | 'manual' | 'import' | 'restore' | 'create';

export interface ProjectVersion {
  versionId: string;
  savedAt: number;
  reason: SaveReason;
  assetIds: string[];
  byteSize: number;
}

export interface ProjectRecord {
  id: string;
  recordVersion: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnail?: ArrayBuffer;
  thumbnailType?: string;
  stats?: SceneStats;
  /** byte size of every stored asset (pruned with garbage collection) */
  assetSizes?: Record<string, number>;
  /** newest first */
  versions: ProjectVersion[];
}

interface DocumentRow {
  key: string;
  projectId: string;
  versionId: string;
  document: SceneDocument;
}

interface AssetRow {
  key: string;
  projectId: string;
  assetId: string;
  data: ArrayBuffer;
}

const docKey = (projectId: string, versionId: string) => `${projectId}:${versionId}`;
const assetKey = (projectId: string, assetId: string) => `${projectId}:${assetId}`;

/** Chooses which versions to keep: the newest plus spaced-out backups. */
export function selectRetainedVersions(versions: ProjectVersion[]): ProjectVersion[] {
  const sorted = [...versions].sort((a, b) => b.savedAt - a.savedAt);
  if (sorted.length === 0) return [];
  const kept = [sorted[0]];
  for (const v of sorted.slice(1)) {
    if (kept.length > MAX_BACKUPS) break;
    if (
      kept[kept.length - 1].savedAt - v.savedAt >= BACKUP_SPACING_MS ||
      v.reason === 'restore' ||
      v.reason === 'import'
    ) {
      kept.push(v);
    }
  }
  // Always keep the immediately previous version too (protects against a corrupted latest save).
  if (sorted[1] && !kept.includes(sorted[1])) kept.splice(1, 0, sorted[1]);
  return kept.slice(0, MAX_BACKUPS + 1);
}

export interface SaveInput {
  document: SceneDocument;
  newAssets: Map<string, ArrayBuffer>;
  referencedAssets: Set<string>;
  reason: SaveReason;
  thumbnail?: { data: ArrayBuffer; type: string };
  stats?: SceneStats;
}

export class ProjectRepository {
  constructor(private readonly dbName?: string) {}

  private db(): Promise<IDBDatabase> {
    return openDatabase(this.dbName);
  }

  async list(): Promise<ProjectRecord[]> {
    const db = await this.db();
    const tx = db.transaction(STORES.projects, 'readonly');
    const all = (await requestToPromise(tx.objectStore(STORES.projects).getAll())) as ProjectRecord[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    const db = await this.db();
    const tx = db.transaction(STORES.projects, 'readonly');
    return (await requestToPromise(tx.objectStore(STORES.projects).get(id))) as ProjectRecord | undefined;
  }

  async create(name: string): Promise<ProjectRecord> {
    const now = Date.now();
    const record: ProjectRecord = {
      id: createId('prj'),
      recordVersion: PROJECT_RECORD_VERSION,
      name: name.trim() || 'Untitled',
      createdAt: now,
      updatedAt: now,
      versions: [],
    };
    const db = await this.db();
    const tx = db.transaction(STORES.projects, 'readwrite');
    tx.objectStore(STORES.projects).add(record);
    await this.commit(tx);
    return record;
  }

  async rename(id: string, name: string): Promise<void> {
    await this.update(id, (r) => {
      r.name = name.trim() || r.name;
    });
  }

  private async update(id: string, fn: (r: ProjectRecord) => void): Promise<ProjectRecord> {
    const db = await this.db();
    const tx = db.transaction(STORES.projects, 'readwrite');
    const store = tx.objectStore(STORES.projects);
    const record = (await requestToPromise(store.get(id))) as ProjectRecord | undefined;
    if (!record) throw new ZinoError('project/missing', 'Project not found.');
    fn(record);
    store.put(record);
    await this.commit(tx);
    return record;
  }

  private async commit(tx: IDBTransaction): Promise<void> {
    try {
      await transactionDone(tx);
    } catch (error) {
      if (isQuotaError(error)) {
        throw new ZinoError(
          'storage/full',
          'Device storage is full, so the project could not be saved. Delete old projects or free up space, then try again.',
          undefined,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Saves a new version atomically: new assets, the document, the project record and garbage
   * collection of assets no longer referenced by any retained version all happen in one transaction.
   */
  async saveVersion(projectId: string, input: SaveInput): Promise<ProjectVersion> {
    const db = await this.db();
    const tx = db.transaction([STORES.projects, STORES.documents, STORES.assets], 'readwrite');
    const projects = tx.objectStore(STORES.projects);
    const documents = tx.objectStore(STORES.documents);
    const assets = tx.objectStore(STORES.assets);
    const record = (await requestToPromise(projects.get(projectId))) as ProjectRecord | undefined;
    if (!record) {
      tx.abort();
      throw new ZinoError('project/missing', 'Project not found (it may have been deleted in another tab).');
    }
    const sizes: Record<string, number> = { ...(record.assetSizes ?? {}) };
    for (const [assetId, data] of input.newAssets) {
      assets.put({ key: assetKey(projectId, assetId), projectId, assetId, data } satisfies AssetRow);
      sizes[assetId] = data.byteLength;
    }
    const version: ProjectVersion = {
      versionId: createId('v'),
      savedAt: Date.now(),
      reason: input.reason,
      assetIds: [...input.referencedAssets],
      byteSize: 0,
    };
    documents.put({
      key: docKey(projectId, version.versionId),
      projectId,
      versionId: version.versionId,
      document: input.document,
    } satisfies DocumentRow);
    const retained = selectRetainedVersions([version, ...record.versions]);
    const retainedIds = new Set(retained.map((v) => v.versionId));
    for (const v of record.versions)
      if (!retainedIds.has(v.versionId)) documents.delete(docKey(projectId, v.versionId));
    const keepAssets = new Set<string>();
    for (const v of retained) for (const a of v.assetIds) keepAssets.add(assetKey(projectId, a));
    const existingKeys = (await requestToPromise(
      assets.index('projectId').getAllKeys(projectId),
    )) as string[];
    for (const key of existingKeys)
      if (!keepAssets.has(key) && !input.newAssets.has(key.slice(projectId.length + 1))) assets.delete(key);
    version.byteSize = version.assetIds.reduce((sum, a) => sum + (sizes[a] ?? 0), 0);
    const prunedSizes: Record<string, number> = {};
    for (const v of retained)
      for (const a of v.assetIds) if (sizes[a] !== undefined) prunedSizes[a] = sizes[a];
    record.assetSizes = prunedSizes;
    record.versions = retained;
    record.updatedAt = version.savedAt;
    if (input.thumbnail) {
      record.thumbnail = input.thumbnail.data;
      record.thumbnailType = input.thumbnail.type;
    }
    if (input.stats) record.stats = input.stats;
    projects.put(record);
    await this.commit(tx);
    return version;
  }

  async loadDocument(
    projectId: string,
    versionId?: string,
  ): Promise<{ record: ProjectRecord; version: ProjectVersion; document: SceneDocument } | null> {
    const record = await this.get(projectId);
    if (!record) throw new ZinoError('project/missing', 'Project not found.');
    const version = versionId ? record.versions.find((v) => v.versionId === versionId) : record.versions[0];
    if (!version) return null;
    const db = await this.db();
    const tx = db.transaction(STORES.documents, 'readonly');
    const row = (await requestToPromise(
      tx.objectStore(STORES.documents).get(docKey(projectId, version.versionId)),
    )) as DocumentRow | undefined;
    if (!row)
      throw new ZinoError(
        'project/corrupt',
        'The saved scene for this version is missing. Try restoring an earlier version.',
      );
    return { record, version, document: migrateSceneDocument(row.document) };
  }

  async readAsset(projectId: string, assetId: string): Promise<ArrayBuffer | undefined> {
    const db = await this.db();
    const tx = db.transaction(STORES.assets, 'readonly');
    const row = (await requestToPromise(tx.objectStore(STORES.assets).get(assetKey(projectId, assetId)))) as
      AssetRow | undefined;
    return row?.data;
  }

  async delete(projectId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([STORES.projects, STORES.documents, STORES.assets], 'readwrite');
    tx.objectStore(STORES.projects).delete(projectId);
    for (const store of [STORES.documents, STORES.assets]) {
      const s = tx.objectStore(store);
      const keys = (await requestToPromise(s.index('projectId').getAllKeys(projectId))) as string[];
      for (const k of keys) s.delete(k);
    }
    await this.commit(tx);
  }

  async duplicate(projectId: string, name?: string): Promise<ProjectRecord> {
    const source = await this.get(projectId);
    if (!source) throw new ZinoError('project/missing', 'Project not found.');
    const db = await this.db();
    const id = createId('prj');
    const now = Date.now();
    const record: ProjectRecord = {
      ...source,
      id,
      name: name ?? `${source.name} copy`,
      createdAt: now,
      updatedAt: now,
      versions: source.versions.slice(0, 1),
    };
    const tx = db.transaction([STORES.projects, STORES.documents, STORES.assets], 'readwrite');
    const latest = source.versions[0];
    if (latest) {
      const docRow = (await requestToPromise(
        tx.objectStore(STORES.documents).get(docKey(projectId, latest.versionId)),
      )) as DocumentRow | undefined;
      if (docRow)
        tx.objectStore(STORES.documents).put({ ...docRow, key: docKey(id, latest.versionId), projectId: id });
      for (const assetId of latest.assetIds) {
        const row = (await requestToPromise(
          tx.objectStore(STORES.assets).get(assetKey(projectId, assetId)),
        )) as AssetRow | undefined;
        if (row) tx.objectStore(STORES.assets).put({ ...row, key: assetKey(id, assetId), projectId: id });
      }
    }
    tx.objectStore(STORES.projects).put(record);
    await this.commit(tx);
    return record;
  }

  /** Makes an older version the newest one (the current state remains available as a backup). */
  async restoreVersion(projectId: string, versionId: string): Promise<void> {
    const loaded = await this.loadDocument(projectId, versionId);
    if (!loaded) throw new ZinoError('project/missing-version', 'That version no longer exists.');
    await this.saveVersion(projectId, {
      document: loaded.document,
      newAssets: new Map(),
      referencedAssets: new Set(loaded.version.assetIds),
      reason: 'restore',
    });
  }

  async exportBundle(projectId: string): Promise<{ blob: Blob; name: string }> {
    const loaded = await this.loadDocument(projectId);
    if (!loaded) throw new ZinoError('project/empty', 'This project has not been saved yet.');
    const assets = new Map<string, ArrayBuffer>();
    for (const id of loaded.version.assetIds) {
      const data = await this.readAsset(projectId, id);
      if (!data)
        throw new ZinoError('project/corrupt', `Asset ${id} is missing; the project cannot be exported.`);
      assets.set(id, data);
    }
    const { name, createdAt, updatedAt } = loaded.record;
    return { blob: encodeBundle({ name, createdAt, updatedAt }, loaded.document, assets), name };
  }

  async importBundle(buffer: ArrayBuffer): Promise<ProjectRecord> {
    const { manifest, assets } = decodeBundle(buffer);
    const document = migrateSceneDocument(manifest.document);
    const record = await this.create(manifest.project.name);
    await this.saveVersion(record.id, {
      document,
      newAssets: assets,
      referencedAssets: new Set(assets.keys()),
      reason: 'import',
    });
    return (await this.get(record.id))!;
  }

  async totalBytes(projectId: string): Promise<number> {
    const db = await this.db();
    const tx = db.transaction(STORES.assets, 'readonly');
    const rows = (await requestToPromise(
      tx.objectStore(STORES.assets).index('projectId').getAll(projectId),
    )) as AssetRow[];
    return rows.reduce((s, r) => s + r.data.byteLength, 0);
  }
}

export interface StorageStatus {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav?.storage?.estimate) return { usage: null, quota: null, persisted: null };
  const [estimate, persisted] = await Promise.all([
    nav.storage.estimate(),
    nav.storage.persisted?.() ?? Promise.resolve(false),
  ]);
  return { usage: estimate.usage ?? null, quota: estimate.quota ?? null, persisted };
}

/** Asks the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export const projectRepository = new ProjectRepository();
