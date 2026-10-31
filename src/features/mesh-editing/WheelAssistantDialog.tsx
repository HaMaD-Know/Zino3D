import { useEffect, useMemo, useState } from 'react';
import type { Mesh } from 'three';
import { Crosshair } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { FieldRow, Toggle } from '../../components/ui/Fields';
import { Spinner } from '../../components/ui/Spinner';
import { useEditorContext } from '../editor/EditorContext';
import { prepareTopology, selectionFromTriangles, type MeshTopology } from '../../engine/geometry/topology';
import { analyzeMeshWheels } from '../../engine/geometry/wheelDetection';
import { separateComponentGroups } from '../../engine/editor/meshOperations';
import { getId, isMesh } from '../../engine/scene/objectUtils';
import { describeError } from '../../utils/errors';
import { formatCount } from '../../utils/format';

interface PartRow {
  key: string;
  componentIds: number[];
  triangles: number;
  score?: number;
  reasons?: string[];
}

const AXIS = ['X', 'Y', 'Z'];

export function WheelAssistantDialog({ onClose }: { onClose: () => void }) {
  const { editor, viewport, ui } = useEditorContext();
  const [mesh] = useState<Mesh | null>(() => {
    const a = editor.activeObject();
    return isMesh(a) ? a : null;
  });
  const [topo, setTopo] = useState<MeshTopology | null>(null);
  const [upAxis, setUpAxis] = useState(1);
  const [yaw, setYaw] = useState(0);
  const [rows, setRows] = useState<PartRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
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
        const result = analyzeMeshWheels({
          positions: t.positions,
          triangles: t.triangles,
          triangleComponent: t.connectivity.triangleComponent,
          componentCount: t.connectivity.componentCount,
          matrix: mesh.matrixWorld.elements,
        });
        const tri = (ids: number[]) =>
          ids.reduce((s, id) => s + t.connectivity.components[id].triangleCount, 0);
        const grouped = new Set(result.groups.flatMap((g) => g.componentIds));
        const list: PartRow[] = result.groups.map((g) => ({
          key: `g${g.anchorId}`,
          componentIds: g.componentIds,
          triangles: tri(g.componentIds),
          score: g.score,
          reasons: g.reasons,
        }));
        for (const c of t.connectivity.components) {
          if (!grouped.has(c.id))
            list.push({ key: `c${c.id}`, componentIds: [c.id], triangles: c.triangleCount });
        }
        list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.triangles - a.triangles);
        setTopo(t);
        setUpAxis(result.upAxis);
        setYaw(result.yawDegrees);
        setRows(list);
        setChecked(
          new Set(
            list
              .filter((r) => (r.score ?? 0) >= 0.55)
              .slice(0, 8)
              .map((r) => r.key),
          ),
        );
      })
      .catch((e) => setError(describeError(e)))
      .finally(() => editor.setBusy(null));
    return () => {
      cancelled = true;
    };
  }, [editor, mesh]);

  const checkedComponents = useMemo(
    () => new Set(rows.filter((r) => checked.has(r.key)).flatMap((r) => r.componentIds)),
    [rows, checked],
  );

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
      if (checkedComponents.has(topo.connectivity.triangleComponent[t])) tris.push(t);
    editor.setElementSelection(selectionFromTriangles(topo, 'face', tris));
  }, [editor, mesh, topo, checkedComponents, preview]);

  const close = () => {
    if (editor.mode === 'edit') editor.exitEditMode();
    onClose();
  };

  const startPicker = () => {
    if (!mesh) return;
    if (editor.mode === 'edit') editor.exitEditMode();
    onClose();
    ui.startWheelPicker(getId(mesh));
  };

  const totalChecked = rows.filter((r) => checked.has(r.key)).reduce((s, r) => s + r.triangles, 0);

  const confirm = async () => {
    if (!mesh) return;
    setBusy(true);
    try {
      editor.exitEditMode();
      const selected = rows.filter((r) => checked.has(r.key));
      const groups = separately
        ? selected.map((r, i) => ({ componentIds: r.componentIds, name: `${prefix || 'Part'}_${i + 1}` }))
        : [{ componentIds: selected.flatMap((r) => r.componentIds), name: prefix || 'Parts' }];
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

  const single = topo?.connectivity.componentCount === 1;
  const noCandidates = !!topo && !single && !rows.some((r) => r.score !== undefined);

  return (
    <Dialog
      title={`Parts of "${mesh.name || 'Mesh'}"`}
      wide
      onClose={close}
      locked={busy}
      footer={
        <>
          <Button icon={Crosshair} onClick={startPicker} disabled={busy}>
            Pick fused wheels by tapping…
          </Button>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          {!single && (
            <Button variant="primary" disabled={busy || checked.size === 0} onClick={() => void confirm()}>
              {busy && <Spinner />} Separate {checked.size} part(s)
            </Button>
          )}
        </>
      }
    >
      {error && <div className="z-error-box">{error}</div>}
      {!topo && !error && (
        <p style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Spinner /> Finding disconnected parts…
        </p>
      )}
      {single && (
        <div className="callout callout--warn">
          This mesh is one connected piece, so the wheels are fused into the body and can't be found as
          separate parts. Use <b>Pick fused wheels by tapping</b>: tap each wheel, adjust the highlighted
          cylinder, and separate it.
        </div>
      )}
      {noCandidates && (
        <div className="callout callout--warn">
          No part looks like a wheel. The wheels may be fused into the body or into a larger part. Tick the
          parts you want by hand, or use <b>Pick fused wheels by tapping</b>.
        </div>
      )}
      {topo && !single && (
        <>
          <p className="z-hint">
            Found {topo.connectivity.componentCount} disconnected parts. Wheel-like parts are ranked by round
            rim shape, size, ground contact (up axis {AXIS[upAxis]}
            {yaw ? `, model turned ${yaw}°` : ''}) and similar siblings; rims and hubs inside a tyre are
            grouped with it. This is a heuristic: check the highlighted preview and correct the selection.
          </p>
          <div className="cand-list" role="list">
            {rows.map((r) => {
              const on = checked.has(r.key);
              return (
                <label key={r.key} className={`cand ${on ? 'cand--checked' : ''}`} role="listitem">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setChecked((s) => {
                        const next = new Set(s);
                        if (next.has(r.key)) next.delete(r.key);
                        else next.add(r.key);
                        return next;
                      })
                    }
                  />
                  <span>
                    {r.componentIds.length > 1
                      ? `Wheel assembly (${r.componentIds.length} parts)`
                      : `Part #${r.componentIds[0] + 1}`}{' '}
                    · {formatCount(r.triangles)} triangles
                    {r.reasons && <small>{r.reasons.join(' · ')}</small>}
                  </span>
                  {r.score !== undefined ? (
                    <span
                      title={`Wheel likelihood ${Math.round(r.score * 100)}%`}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <span className="score-bar">
                        <i style={{ width: `${Math.round(r.score * 100)}%` }} />
                      </span>
                      <span className="z-hint">{Math.round(r.score * 100)}%</span>
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
            label="Create one object per row (otherwise one combined object)"
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
