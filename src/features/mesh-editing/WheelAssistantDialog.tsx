import { useEffect, useMemo, useState } from 'react';
import { Box3, Vector3, type Mesh } from 'three';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { FieldRow, Toggle } from '../../components/ui/Fields';
import { Spinner } from '../../components/ui/Spinner';
import { useEditorContext } from '../editor/EditorContext';
import { prepareTopology, selectionFromTriangles, type MeshTopology } from '../../engine/geometry/topology';
import {
  collectComponentPoints,
  detectWheelCandidates,
  type WheelCandidate,
} from '../../engine/geometry/wheelDetection';
import { separateComponentGroups } from '../../engine/editor/meshOperations';
import { getId, isMesh } from '../../engine/scene/objectUtils';
import { describeError } from '../../utils/errors';
import { formatCount } from '../../utils/format';

interface PartRow {
  id: number;
  triangles: number;
  candidate?: WheelCandidate;
}

const AXIS = ['X', 'Y', 'Z'];

export function WheelAssistantDialog({ onClose }: { onClose: () => void }) {
  const { editor, viewport } = useEditorContext();
  const [mesh] = useState<Mesh | null>(() => {
    const a = editor.activeObject();
    return isMesh(a) ? a : null;
  });
  const [topo, setTopo] = useState<MeshTopology | null>(null);
  const [upAxis, setUpAxis] = useState(1);
  const [rows, setRows] = useState<PartRow[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [separately, setSeparately] = useState(true);
  const [centerOrigins, setCenterOrigins] = useState(true);
  const [prefix, setPrefix] = useState('Wheel');
  const [preview, setPreview] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mesh) return;
    let cancelled = false;
    editor.setBusy('Analyzing parts…');
    prepareTopology(mesh.geometry)
      .then((t) => {
        if (cancelled) return;
        mesh.updateWorldMatrix(true, false);
        const points = collectComponentPoints(
          t.positions,
          t.triangles,
          t.connectivity.triangleComponent,
          t.connectivity.componentCount,
          mesh.matrixWorld.elements,
        );
        const comps = t.connectivity.components.map((c) => {
          const box = new Box3(new Vector3(...c.min), new Vector3(...c.max)).applyMatrix4(mesh.matrixWorld);
          return {
            id: c.id,
            min: box.min.toArray() as [number, number, number],
            max: box.max.toArray() as [number, number, number],
            points: points[c.id],
          };
        });
        const model = comps.reduce(
          (b, c) => b.union(new Box3(new Vector3(...c.min), new Vector3(...c.max))),
          new Box3(),
        );
        const result = detectWheelCandidates(comps, {
          min: model.min.toArray() as [number, number, number],
          max: model.max.toArray() as [number, number, number],
        });
        const byId = new Map(result.candidates.map((c) => [c.componentId, c]));
        const list: PartRow[] = t.connectivity.components.map((c) => ({
          id: c.id,
          triangles: c.triangleCount,
          candidate: byId.get(c.id),
        }));
        list.sort(
          (a, b) => (b.candidate?.score ?? -1) - (a.candidate?.score ?? -1) || b.triangles - a.triangles,
        );
        setTopo(t);
        setUpAxis(result.upAxis);
        setRows(list);
        setChecked(
          new Set(
            result.candidates
              .filter((c) => c.score >= 0.55)
              .slice(0, 8)
              .map((c) => c.componentId),
          ),
        );
      })
      .catch((e) => setError(describeError(e)))
      .finally(() => editor.setBusy(null));
    return () => {
      cancelled = true;
    };
  }, [editor, mesh]);

  // Live preview: highlight checked parts using Edit Mode face selection.
  useEffect(() => {
    if (!mesh || !topo) return;
    if (!preview) {
      if (editor.mode === 'edit') editor.exitEditMode();
      return;
    }
    if (editor.mode !== 'edit' || editor.editTargetId !== getId(mesh)) {
      editor.select([getId(mesh)]);
      if (!editor.enterEditMode()) return;
    }
    editor.setElementMode('face');
    const tris: number[] = [];
    for (let t = 0; t < topo.triangleCount; t++)
      if (checked.has(topo.connectivity.triangleComponent[t])) tris.push(t);
    editor.setElementSelection(selectionFromTriangles(topo, 'face', tris));
  }, [editor, mesh, topo, checked, preview]);

  const close = () => {
    if (editor.mode === 'edit') editor.exitEditMode();
    onClose();
  };

  const totalChecked = useMemo(
    () => rows.filter((r) => checked.has(r.id)).reduce((s, r) => s + r.triangles, 0),
    [rows, checked],
  );

  const confirm = async () => {
    if (!mesh) return;
    setBusy(true);
    try {
      editor.exitEditMode();
      const ids = [...checked];
      const groups = separately
        ? ids.map((id, i) => ({ componentIds: [id], name: `${prefix || 'Part'}_${i + 1}` }))
        : [{ componentIds: ids, name: prefix || 'Parts' }];
      const created = await separateComponentGroups(editor, getId(mesh), groups, { centerOrigins });
      editor.message(
        'success',
        `Created ${created.length} object(s). Undo is available if the result is not right.`,
      );
      viewport?.requestRender();
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!mesh) {
    return (
      <Dialog
        title="Wheel & parts assistant"
        onClose={onClose}
        footer={<Button onClick={onClose}>Close</Button>}
      >
        <p>Select a mesh object first.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Parts of "${mesh.name || 'Mesh'}"`}
      wide
      onClose={close}
      locked={busy}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || checked.size === 0} onClick={() => void confirm()}>
            {busy && <Spinner />} Separate {checked.size} part(s)
          </Button>
        </>
      }
    >
      {error && <div className="z-error-box">{error}</div>}
      {!topo && !error && (
        <p style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Spinner /> Finding disconnected parts…
        </p>
      )}
      {topo && topo.connectivity.componentCount === 1 && (
        <div className="callout callout--warn">
          This mesh is a single connected piece, so wheels (or other parts) are fused into the body and cannot
          be detected from geometry alone. Close this dialog, enter <b>Edit Mode → Face</b>, tap the faces of
          a wheel (enable Multi-select or hold Shift), then press <b>Separate</b> (P).
        </div>
      )}
      {topo && topo.connectivity.componentCount > 1 && (
        <>
          <p className="z-hint">
            Found {topo.connectivity.componentCount} disconnected parts. Wheel-like parts are ranked by shape
            (round profile), size, contact with the ground (detected up axis: {AXIS[upAxis]}) and
            similar-sized siblings. This is a heuristic: check the highlighted preview and correct the
            selection before confirming.
          </p>
          <div className="cand-list" role="list">
            {rows.map((r) => {
              const on = checked.has(r.id);
              return (
                <label key={r.id} className={`cand ${on ? 'cand--checked' : ''}`} role="listitem">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setChecked((s) => {
                        const next = new Set(s);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                  />
                  <span>
                    Part #{r.id + 1} · {formatCount(r.triangles)} triangles
                    {r.candidate && <small>{r.candidate.reasons.join(' · ')}</small>}
                  </span>
                  {r.candidate ? (
                    <span
                      title={`Wheel likelihood ${Math.round(r.candidate.score * 100)}%`}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <span className="score-bar">
                        <i style={{ width: `${Math.round(r.candidate.score * 100)}%` }} />
                      </span>
                      <span className="z-hint">{Math.round(r.candidate.score * 100)}%</span>
                    </span>
                  ) : (
                    <span className="z-hint">—</span>
                  )}
                </label>
              );
            })}
          </div>
          <p className="z-hint">{formatCount(totalChecked)} triangles selected.</p>
          <FieldRow label="Name prefix">
            <input
              className="z-input"
              aria-label="Name prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </FieldRow>
          <Toggle
            label="Create one object per part (otherwise one combined object)"
            checked={separately}
            onChange={setSeparately}
          />
          <Toggle
            label="Move each new object's origin to its center (wheels rotate around their axle)"
            checked={centerOrigins}
            onChange={setCenterOrigins}
          />
          <Toggle label="Preview selection in the viewport" checked={preview} onChange={setPreview} />
        </>
      )}
    </Dialog>
  );
}
