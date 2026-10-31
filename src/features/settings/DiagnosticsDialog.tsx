import { useEffect, useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { useEditorContext } from '../editor/EditorContext';
import { computeSceneStats } from '../../formats/sceneStats';
import { getStorageStatus, projectRepository, type StorageStatus } from '../../storage/projectRepository';
import { formatBytes, formatCount } from '../../utils/format';
import { log } from '../../utils/logging';

export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const { editor, viewport, session } = useEditorContext();
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [projectBytes, setProjectBytes] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const stats = computeSceneStats(editor.root.children);
  const d = viewport?.diagnostics();
  useEffect(() => {
    void getStorageStatus().then(setStorage);
    void projectRepository.totalBytes(session.projectId).then(setProjectBytes, () => setProjectBytes(null));
  }, [session.projectId, tick]);
  const rows: Array<[string, string]> = [
    ['Renderer', d ? `${d.webgl}` : 'not running'],
    ['GPU', d?.gpu ?? '—'],
    ['Max texture size', d ? `${d.maxTextureSize}px` : '—'],
    ['Canvas / pixel ratio', d ? `${d.canvas} @ ${d.pixelRatio.toFixed(2)}×` : '—'],
    ['Draw calls (last frame)', d ? formatCount(d.drawCalls) : '—'],
    ['Triangles drawn (last frame)', d ? formatCount(d.triangles) : '—'],
    ['GPU geometries / textures', d ? `${d.gpuGeometries} / ${d.gpuTextures}` : '—'],
    ['Scene objects', formatCount(stats.objects)],
    ['Meshes / geometries', `${formatCount(stats.meshes)} / ${formatCount(stats.geometries)}`],
    ['Scene triangles', formatCount(stats.triangles)],
    ['Materials / textures', `${stats.materials} / ${stats.textures}`],
    ['Geometry data in memory', formatBytes(stats.geometryBytes)],
    ['Undo steps / history memory', `${editor.history.size} / ${formatBytes(editor.history.memoryUsage())}`],
    ['Stored project size (all versions)', projectBytes === null ? '—' : formatBytes(projectBytes)],
    [
      'Device storage used',
      storage?.usage != null
        ? `${formatBytes(storage.usage)} of ${formatBytes(storage.quota ?? 0)}`
        : 'not reported by this browser',
    ],
    [
      'Persistent storage',
      storage?.persisted == null
        ? 'unknown'
        : storage.persisted
          ? 'granted'
          : 'not granted (browser may evict data)',
    ],
    ['Online', navigator.onLine ? 'yes' : 'no (offline mode)'],
    [
      'Service worker',
      'serviceWorker' in navigator
        ? navigator.serviceWorker.controller
          ? 'active (offline ready)'
          : 'not active'
        : 'unsupported',
    ],
  ];
  const recent = log
    .recent()
    .filter((l) => l.level === 'error' || l.level === 'warn')
    .slice(-8);
  return (
    <Dialog
      title="Diagnostics"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => setTick((t) => t + 1)}>Refresh</Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <dl className="z-stats">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {recent.length > 0 && (
        <>
          <span className="z-label">Recent warnings and errors (local only)</span>
          <ul className="z-warning-list">
            {recent.map((l, i) => (
              <li key={i}>
                {new Date(l.time).toLocaleTimeString()} — {l.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
