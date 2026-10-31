import { useEffect, useMemo, useRef, useState } from 'react';
import { type BufferGeometry, type Mesh, Vector3 } from 'three';
import { Scissors, X } from 'lucide-react';
import { Button, IconButton } from '../../components/ui/Button';
import { FieldRow, SliderField } from '../../components/ui/Fields';
import { useEditorChannels, useEditorContext } from '../editor/EditorContext';
import {
  estimateWheelFromTap,
  trianglesInCylinder,
  worldPositions,
  type WheelCylinder,
} from '../../engine/geometry/wheelPicker';
import { readPositions, triangleVertexIndices } from '../../engine/geometry/attributes';
import { emptyElementSelection, getTopology, selectionFromTriangles } from '../../engine/geometry/topology';
import { separateElementSelection } from '../../engine/editor/meshOperations';
import { isMesh } from '../../engine/scene/objectUtils';
import { formatCount } from '../../utils/format';

/**
 * Floating panel for separating wheels that are fused into the body mesh: tap a wheel, adjust the
 * estimated cylinder, preview the selected faces, then separate. Repeat for each wheel.
 */
export function WheelPicker({ meshId, onClose }: { meshId: string; onClose: () => void }) {
  const { editor, viewport } = useEditorContext();
  useEditorChannels(editor, ['scene', 'edit', 'mode']);
  const [upAxis, setUpAxis] = useState<1 | 2>(1);
  const [cyl, setCyl] = useState<WheelCylinder | null>(null);
  const [baseRadius, setBaseRadius] = useState(1);
  const [count, setCount] = useState(0);
  const [next, setNext] = useState(1);
  const cache = useRef<{ geometry: BufferGeometry; world: Float32Array; triangles: Uint32Array } | null>(
    null,
  );
  const mesh = editor.getObject(meshId);
  const target: Mesh | null = isMesh(mesh) ? mesh : null;

  const input = () => {
    if (!target) return null;
    target.updateWorldMatrix(true, false);
    if (!cache.current || cache.current.geometry !== target.geometry) {
      cache.current = {
        geometry: target.geometry,
        world: worldPositions(readPositions(target.geometry), target.matrixWorld.elements),
        triangles: triangleVertexIndices(target.geometry),
      };
    }
    return cache.current;
  };

  // Enter Edit Mode on the mesh (face preview) and take over viewport taps while the picker is open.
  useEffect(() => {
    if (!target) return;
    editor.select([meshId]);
    if (editor.mode !== 'edit' || editor.editTargetId !== meshId) editor.enterEditMode();
    editor.setElementMode('face');
    editor.updateSettings({ tool: 'select' });
    return () => {
      if (viewport) viewport.pickInterceptor = null;
      if (editor.mode === 'edit') editor.exitEditMode();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshId]);

  useEffect(() => {
    if (!viewport) return;
    viewport.pickInterceptor = (hit) => {
      const data = input();
      if (!data || !target) return true;
      if (!hit || hit.object !== target) {
        editor.message('info', `Tap a wheel on "${target.name || 'the mesh'}".`);
        return true;
      }
      const c = estimateWheelFromTap(
        { world: data.world, triangles: data.triangles },
        hit.point.toArray() as [number, number, number],
        upAxis,
      );
      setBaseRadius(c.radius);
      setCyl(c);
      return true;
    };
    return () => {
      viewport.pickInterceptor = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, target, upAxis]);

  // Live preview of the faces inside the cylinder.
  useEffect(() => {
    if (!target || editor.editTargetId !== meshId) return;
    const data = input();
    if (!cyl || !data) {
      editor.setElementSelection(emptyElementSelection());
      setCount(0);
      return;
    }
    const mask = trianglesInCylinder({ world: data.world, triangles: data.triangles }, cyl);
    const tris: number[] = [];
    for (let t = 0; t < mask.length; t++) if (mask[t]) tris.push(t);
    editor.setElementSelection(selectionFromTriangles(getTopology(target.geometry), 'face', tris));
    setCount(tris.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cyl, target?.geometry]);

  const tooBig = useMemo(() => {
    if (!cyl || !target) return false;
    target.geometry.computeBoundingBox();
    const size = target.geometry.boundingBox!.clone().applyMatrix4(target.matrixWorld).getSize(new Vector3());
    const horizontal = upAxis === 1 ? Math.max(size.x, size.z) : Math.max(size.x, size.y);
    return cyl.radius * 2 > horizontal * 0.45;
  }, [cyl, target, upAxis]);

  const ranges = useMemo(
    () => ({ rMin: baseRadius * 0.4, rMax: baseRadius * 2, dMax: baseRadius * 3 }),
    [baseRadius],
  );

  if (!target) {
    return (
      <div className="wheel-picker" role="dialog" aria-label="Wheel picker">
        <p>The mesh no longer exists.</p>
        <Button onClick={onClose}>Close</Button>
      </div>
    );
  }

  return (
    <div className="wheel-picker" role="dialog" aria-label="Wheel picker">
      <div className="wheel-picker__head">
        <b>Wheel picker</b>
        <IconButton icon={X} label="Close wheel picker" size="sm" onClick={onClose} />
      </div>
      <p className="z-hint">
        {cyl
          ? 'Adjust the size until only the wheel is highlighted, then separate it. Tap another spot to re-centre.'
          : `Tap the centre of a wheel on “${target.name || 'mesh'}” (side view works best).`}
      </p>
      <FieldRow label="Up axis">
        <select
          className="z-select"
          aria-label="Up axis"
          value={upAxis}
          onChange={(e) => setUpAxis(Number(e.target.value) as 1 | 2)}
        >
          <option value={1}>Y (glTF default)</option>
          <option value={2}>Z</option>
        </select>
      </FieldRow>
      {cyl && (
        <>
          <SliderField
            label="Radius"
            value={cyl.radius}
            min={ranges.rMin}
            max={ranges.rMax}
            step={baseRadius / 200}
            onChange={(v) => setCyl({ ...cyl, radius: v })}
          />
          <SliderField
            label="Depth"
            value={cyl.depth}
            min={0}
            max={ranges.dMax}
            step={baseRadius / 200}
            onChange={(v) => setCyl({ ...cyl, depth: v })}
          />
          <p className="z-hint">{formatCount(count)} faces selected (shown in blue).</p>
          {tooBig && (
            <div className="callout callout--warn">
              This is very large for a wheel — the tap probably hit the body. Tap the middle of a wheel,
              ideally in a side view.
            </div>
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          icon={Scissors}
          disabled={!cyl || count === 0}
          onClick={() => {
            const id = separateElementSelection(editor, 'move', {
              name: `Wheel_${next}`,
              centerOrigin: true,
            });
            if (id) {
              setNext((n) => n + 1);
              setCyl(null);
              // Separation replaced the body geometry; keep editing the body for the next wheel.
              if (editor.mode !== 'edit') {
                editor.select([meshId]);
                editor.enterEditMode();
              }
            }
          }}
        >
          Separate as Wheel_{next}
        </Button>
        <Button onClick={() => setCyl(null)} disabled={!cyl}>
          Clear
        </Button>
        <Button onClick={onClose}>Done</Button>
      </div>
      <p className="z-hint">
        Every step can be undone. Wheels get their origin at their centre so they rotate around the axle.
      </p>
    </div>
  );
}
