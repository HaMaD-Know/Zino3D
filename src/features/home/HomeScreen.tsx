import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Copy,
  Download,
  EllipsisVertical,
  FileUp,
  FolderOpen,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Sparkles,
  Trash,
  Upload,
} from 'lucide-react';
import { Button, IconButton } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { MenuButton } from '../../components/ui/Menu';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import {
  getStorageStatus,
  projectRepository,
  requestPersistentStorage,
  type ProjectRecord,
  type StorageStatus,
} from '../../storage/projectRepository';
import { clearSessionMarker, readSessionMarker, type SessionMarker } from '../../storage/session';
import { pickFiles, saveFile } from '../../platform/fileIO';
import { IMPORT_ACCEPT } from '../../formats/detect';
import { describeError } from '../../utils/errors';
import { baseName, formatBytes, formatCount, formatTime } from '../../utils/format';
import { PreferencesDialog } from '../settings/PreferencesDialog';
import type { EditorLaunch } from '../editor/EditorScreen';

/**
 * The unclean-shutdown marker is read once, when the app starts. Returning to the home screen from the
 * editor must not show the recovery banner (the editor clears the marker asynchronously on close).
 */
let startupMarker: SessionMarker | null = readSessionMarker();

function Thumbnail({ record }: { record: ProjectRecord }) {
  const url = useMemo(
    () =>
      record.thumbnail
        ? URL.createObjectURL(new Blob([record.thumbnail], { type: record.thumbnailType ?? 'image/jpeg' }))
        : null,
    [record.thumbnail, record.thumbnailType],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url ? (
    <img src={url} alt="" />
  ) : (
    <span className="project-card__placeholder">
      <Box size={36} />
    </span>
  );
}

function NameDialog({
  title,
  initial,
  confirm,
  onDone,
}: {
  title: string;
  initial: string;
  confirm: string;
  onDone: (name: string | null) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Dialog
      title={title}
      onClose={() => onDone(null)}
      footer={
        <>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => onDone(name.trim())}>
            {confirm}
          </Button>
        </>
      }
    >
      <input
        className="z-input"
        aria-label="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) onDone(name.trim());
        }}
      />
    </Dialog>
  );
}

function VersionsDialog({
  record,
  onClose,
  onOpen,
}: {
  record: ProjectRecord;
  onClose: () => void;
  onOpen: (versionId?: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={`Versions of "${record.name}"`}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <p className="z-hint">
        Zino3D keeps the latest save plus spaced-out backups (at least 5 minutes apart). Restoring makes that
        version the newest one; the current state stays available as a backup.
      </p>
      {record.versions.length === 0 && <p>This project has no saved versions yet.</p>}
      <div className="version-list">
        {record.versions.map((v, i) => (
          <div key={v.versionId} className="version-row">
            <div>
              <b>{i === 0 ? 'Latest' : `Backup ${i}`}</b>
              <small>
                {formatTime(v.savedAt)} · {v.reason} · {formatBytes(v.byteSize)}
              </small>
            </div>
            {i === 0 ? (
              <Button size="sm" onClick={() => onOpen()}>
                Open
              </Button>
            ) : (
              <Button
                size="sm"
                icon={RotateCcw}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await projectRepository.restoreVersion(record.id, v.versionId);
                    toast.show('success', 'Version restored.');
                    onOpen();
                  } catch (e) {
                    toast.show('error', describeError(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Restore
              </Button>
            )}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function HomeScreen({ onOpen }: { onOpen: (launch: EditorLaunch) => void }) {
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [marker, setMarkerState] = useState<SessionMarker | null>(startupMarker);
  const setMarker = (m: SessionMarker | null) => {
    startupMarker = m;
    setMarkerState(m);
  };
  const [naming, setNaming] = useState<{ kind: 'new' | 'rename' | 'sample'; record?: ProjectRecord } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<ProjectRecord | null>(null);
  const [versionsOf, setVersionsOf] = useState<ProjectRecord | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await projectRepository.list());
      setStorage(await getStorageStatus());
    } catch (e) {
      setError(describeError(e));
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = (launch: EditorLaunch) => {
    // Opening any project consumes the startup recovery prompt.
    startupMarker = null;
    onOpen(launch);
  };

  const create = async (name: string, extra: Partial<EditorLaunch> = {}) => {
    try {
      const record = await projectRepository.create(name);
      void requestPersistentStorage();
      open({ projectId: record.id, ...extra });
    } catch (e) {
      toast.show('error', describeError(e));
    }
  };

  const importModel = async () => {
    const files = await pickFiles({ accept: IMPORT_ACCEPT, multiple: true });
    if (!files.length) return;
    const primary = files.find((f) => /\.(glb|gltf|obj|stl|fbx)$/i.test(f.name)) ?? files[0];
    await create(baseName(primary.name), { importFiles: files });
  };

  const openProjectFile = async () => {
    const [file] = await pickFiles({ accept: '.zino3d' });
    if (!file) return;
    setBusy('Opening project file…');
    try {
      const record = await projectRepository.importBundle(await file.arrayBuffer());
      open({ projectId: record.id });
    } catch (e) {
      toast.show('error', describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const usagePct =
    storage?.usage != null && storage.quota ? Math.min(100, (storage.usage / storage.quota) * 100) : null;
  const recoverable = marker && projects?.find((p) => p.id === marker.projectId);

  return (
    <div className="home">
      <div className="home__inner">
        <header className="home__header">
          <img className="home__logo" src="./icons/zino3d.svg" alt="" />
          <div>
            <h1>Zino3D</h1>
            <p>Universal 3D model editor · works offline · your files never leave this device</p>
          </div>
          <span className="home__header-spacer" />
          <IconButton icon={Settings} label="Settings" onClick={() => setPrefsOpen(true)} />
        </header>

        {recoverable && marker && (
          <div className="recovery-banner" role="alert">
            <p>
              <b>Zino3D did not close cleanly.</b> “{recoverable.name}” was last saved{' '}
              {marker.lastSavedAt ? formatTime(marker.lastSavedAt) : 'never'}
              {marker.unsavedChanges ? '; changes made after that moment may be missing.' : '.'} You can
              reopen it or restore an earlier backup.
            </p>
            <Button variant="primary" onClick={() => open({ projectId: recoverable.id })}>
              Reopen
            </Button>
            <Button onClick={() => setVersionsOf(recoverable)}>Versions…</Button>
            <Button
              variant="ghost"
              onClick={() => {
                clearSessionMarker();
                setMarker(null);
              }}
            >
              Dismiss
            </Button>
          </div>
        )}

        <div className="home__actions">
          <button
            type="button"
            className="action-card action-card--primary"
            onClick={() => setNaming({ kind: 'new' })}
          >
            <span className="action-card__icon">
              <Plus size={20} />
            </span>
            <span>
              <b>New project</b>
              <small>Start with an empty scene</small>
            </span>
          </button>
          <button type="button" className="action-card" onClick={() => void importModel()}>
            <span className="action-card__icon">
              <Upload size={20} />
            </span>
            <span>
              <b>Import 3D model</b>
              <small>GLB, glTF, OBJ, STL, FBX</small>
            </span>
          </button>
          <button type="button" className="action-card" onClick={() => void openProjectFile()}>
            <span className="action-card__icon">
              <FolderOpen size={20} />
            </span>
            <span>
              <b>Open project file</b>
              <small>A .zino3d backup or shared project</small>
            </span>
          </button>
          <button
            type="button"
            className="action-card"
            onClick={() => void create('Sample car', { sample: true })}
          >
            <span className="action-card__icon">
              <Sparkles size={20} />
            </span>
            <span>
              <b>Sample project</b>
              <small>A car with separable wheels</small>
            </span>
          </button>
        </div>

        <div className="home__section-head">
          <h2>Recent projects</h2>
          {storage && (
            <span
              className="storage-bar"
              title={
                storage.persisted
                  ? 'Persistent storage granted'
                  : 'The browser may clear data under storage pressure'
              }
            >
              {usagePct !== null && (
                <span className="storage-bar__track">
                  <i style={{ width: `${usagePct}%` }} />
                </span>
              )}
              {storage.usage != null
                ? `${formatBytes(storage.usage)} used${storage.quota ? ` of ${formatBytes(storage.quota)}` : ''}`
                : 'Storage usage unavailable'}
              {storage.persisted === false && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await requestPersistentStorage();
                    await refresh();
                  }}
                >
                  Keep data
                </Button>
              )}
            </span>
          )}
        </div>

        {error && <div className="z-error-box">{error}</div>}
        {busy && (
          <p style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Spinner /> {busy}
          </p>
        )}
        {projects === null ? (
          <p style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Spinner /> Loading projects…
          </p>
        ) : projects.length === 0 ? (
          <div className="home-empty">
            <Box size={40} color="var(--z-accent)" />
            <b>No projects yet</b>
            <p>
              Import a model generated by an AI tool (for example a GLB) or any other 3D file to start
              editing. Try the sample project to explore mesh separation.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <Button variant="primary" icon={FileUp} onClick={() => void importModel()}>
                Import 3D model
              </Button>
              <Button icon={Sparkles} onClick={() => void create('Sample car', { sample: true })}>
                Open sample
              </Button>
            </div>
          </div>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <article key={p.id} className="project-card">
                <button
                  type="button"
                  className="project-card__thumb"
                  onClick={() => open({ projectId: p.id })}
                  aria-label={`Open ${p.name}`}
                >
                  <Thumbnail record={p} />
                </button>
                <div className="project-card__meta">
                  <div>
                    <b title={p.name}>{p.name}</b>
                    <small>
                      {formatTime(p.updatedAt)}
                      {p.stats ? ` · ${formatCount(p.stats.meshes)} meshes` : ''}
                    </small>
                  </div>
                  <MenuButton
                    entries={[
                      { label: 'Open', icon: FolderOpen, onSelect: () => open({ projectId: p.id }) },
                      {
                        label: 'Rename',
                        icon: Pencil,
                        onSelect: () => setNaming({ kind: 'rename', record: p }),
                      },
                      {
                        label: 'Duplicate',
                        icon: Copy,
                        onSelect: async () => {
                          try {
                            await projectRepository.duplicate(p.id);
                            await refresh();
                          } catch (e) {
                            toast.show('error', describeError(e));
                          }
                        },
                      },
                      { label: 'Versions & recovery', icon: RotateCcw, onSelect: () => setVersionsOf(p) },
                      {
                        label: 'Download project file',
                        icon: Download,
                        disabled: p.versions.length === 0,
                        onSelect: async () => {
                          try {
                            const { blob, name } = await projectRepository.exportBundle(p.id);
                            await saveFile(blob, `${name}.zino3d`);
                          } catch (e) {
                            toast.show('error', describeError(e));
                          }
                        },
                      },
                      { kind: 'separator' },
                      { label: 'Delete…', icon: Trash, danger: true, onSelect: () => setConfirmDelete(p) },
                    ]}
                    render={(open) => (
                      <IconButton
                        icon={EllipsisVertical}
                        label={`Project actions for ${p.name}`}
                        onClick={(e) => open(e.currentTarget)}
                      />
                    )}
                  />
                </div>
              </article>
            ))}
          </div>
        )}

        <footer className="home__footer">
          <span>Zino3D {import.meta.env.VITE_APP_VERSION ?? '0.1.0'}</span>
          <span>No account · no uploads · no analytics</span>
          <span>{navigator.onLine ? 'Online' : 'Offline mode'}</span>
        </footer>
      </div>

      {naming && (
        <NameDialog
          title={naming.kind === 'rename' ? 'Rename project' : 'New project'}
          confirm={naming.kind === 'rename' ? 'Rename' : 'Create'}
          initial={naming.record?.name ?? 'Untitled project'}
          onDone={async (name) => {
            const n = naming;
            setNaming(null);
            if (!name) return;
            if (n.kind === 'rename' && n.record) {
              await projectRepository.rename(n.record.id, name);
              await refresh();
            } else await create(name);
          }}
        />
      )}
      {confirmDelete && (
        <Dialog
          title="Delete project?"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                variant="danger"
                icon={Trash}
                onClick={async () => {
                  const p = confirmDelete;
                  setConfirmDelete(null);
                  try {
                    await projectRepository.delete(p.id);
                    if (marker?.projectId === p.id) {
                      clearSessionMarker();
                      setMarker(null);
                    }
                    await refresh();
                    toast.show('success', `Deleted “${p.name}”.`);
                  } catch (e) {
                    toast.show('error', describeError(e));
                  }
                }}
              >
                Delete permanently
              </Button>
            </>
          }
        >
          <p>
            “{confirmDelete.name}” and all of its saved versions will be removed from this device. This cannot
            be undone. Download a project file first if you want a backup.
          </p>
        </Dialog>
      )}
      {versionsOf && (
        <VersionsDialog
          record={versionsOf}
          onClose={() => setVersionsOf(null)}
          onOpen={(versionId) => {
            setVersionsOf(null);
            clearSessionMarker();
            open({ projectId: versionsOf.id, versionId });
          }}
        />
      )}
      {prefsOpen && <PreferencesDialog onClose={() => setPrefsOpen(false)} />}
    </div>
  );
}
