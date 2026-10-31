import { useState } from 'react';
import { Link, RotateCcw } from 'lucide-react';
import { Box3, Vector3, type Object3D } from 'three';
import { Section } from '../../components/ui/Section';
import { Vec3Field, NumberInput, FieldRow } from '../../components/ui/Fields';
import { Button, IconButton } from '../../components/ui/Button';
import { MenuButton } from '../../components/ui/Menu';
import { useEditorChannels, useEditorContext } from '../editor/EditorContext';
import {
  applyTransform,
  cursorToSelection,
  resetTransform,
  setOrigin,
  setTransform,
} from '../../engine/editor/objectOperations';
import { getId } from '../../engine/scene/objectUtils';
import { RAD2DEG, roundTo } from '../../utils/math';

export function TransformSection({ object }: { object: Object3D }) {
  const { editor } = useEditorContext();
  useEditorChannels(editor, ['transform', 'scene', 'settings']);
  const [uniform, setUniform] = useState(true);
  const id = getId(object);
  const locked = editor.isLocked(object);
  const p = object.position.toArray() as [number, number, number];
  const r = [object.rotation.x, object.rotation.y, object.rotation.z].map((v) => roundTo(v * RAD2DEG, 4)) as [
    number,
    number,
    number,
  ];
  const s = object.scale.toArray() as [number, number, number];
  object.updateWorldMatrix(true, true);
  const box = new Box3().expandByObject(object, true);
  const dims = box.isEmpty() ? null : box.getSize(new Vector3());
  const world = new Vector3().setFromMatrixPosition(object.matrixWorld);

  return (
    <Section
      title="Transform"
      actions={
        <MenuButton
          entries={[
            { kind: 'label', label: 'Reset' },
            { label: 'Reset all', onSelect: () => resetTransform(editor) },
            { label: 'Reset position', onSelect: () => resetTransform(editor, { position: true }) },
            { label: 'Reset rotation', onSelect: () => resetTransform(editor, { rotation: true }) },
            { label: 'Reset scale', onSelect: () => resetTransform(editor, { scale: true }) },
            { kind: 'separator' },
            { kind: 'label', label: 'Apply (bake into geometry)' },
            { label: 'Apply all transforms', onSelect: () => applyTransform(editor, 'all') },
            { label: 'Apply rotation & scale', onSelect: () => applyTransform(editor, 'rotation-scale') },
            { label: 'Apply scale', onSelect: () => applyTransform(editor, 'scale') },
          ]}
          render={(open) => (
            <IconButton
              icon={RotateCcw}
              label="Reset / apply transform"
              size="sm"
              disabled={locked}
              onClick={(e) => open(e.currentTarget)}
            />
          )}
        />
      }
    >
      {locked && (
        <div className="callout callout--warn">This object is locked. Unlock it to edit its transform.</div>
      )}
      <Vec3Field
        label="Position"
        value={p}
        disabled={locked}
        onCommit={(v) => setTransform(editor, id, { position: v }, 'position')}
      />
      <Vec3Field
        label="Rotation °"
        value={r}
        step={5}
        precision={2}
        disabled={locked}
        onCommit={(v) => setTransform(editor, id, { rotation: v }, 'rotation')}
      />
      <div className="z-field-row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Scale
          <IconButton
            icon={Link}
            label={uniform ? 'Uniform scale on' : 'Uniform scale off'}
            size="sm"
            pressed={uniform}
            onClick={() => setUniform(!uniform)}
          />
        </label>
        <div className="z-vec3">
          {(['x', 'y', 'z'] as const).map((axis, i) => (
            <NumberInput
              key={axis}
              axis={axis}
              label={`Scale ${axis.toUpperCase()}`}
              value={s[i]}
              disabled={locked}
              onCommit={(v) => {
                let next = [...s] as [number, number, number];
                if (uniform && s[i] !== 0) {
                  const f = v / s[i];
                  next = s.map((x) => x * f) as [number, number, number];
                } else next[i] = v;
                setTransform(editor, id, { scale: next }, 'scale');
              }}
            />
          ))}
        </div>
      </div>
      <FieldRow label="World pos.">
        <span className="z-hint" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {world
            .toArray()
            .map((v) => roundTo(v, 3))
            .join(', ')}
        </span>
      </FieldRow>
      {dims && (
        <FieldRow label="Dimensions">
          <span className="z-hint" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {dims
              .toArray()
              .map((v) => roundTo(v, 3))
              .join(' × ')}
          </span>
        </FieldRow>
      )}
      <div className="z-divider" />
      <span className="z-label">Origin (pivot)</span>
      <div className="z-btn-grid">
        <Button size="sm" disabled={locked} onClick={() => setOrigin(editor, 'geometry-center')}>
          To geometry center
        </Button>
        <Button size="sm" disabled={locked} onClick={() => setOrigin(editor, 'geometry-bottom')}>
          To bottom center
        </Button>
        <Button size="sm" disabled={locked} onClick={() => setOrigin(editor, 'cursor')}>
          To 3D cursor
        </Button>
        <Button size="sm" disabled={locked} onClick={() => setOrigin(editor, 'world-origin')}>
          To world origin
        </Button>
      </div>
      <div className="z-btn-grid">
        <Button size="sm" onClick={() => cursorToSelection(editor)}>
          Cursor to selection
        </Button>
        <Button size="sm" onClick={() => editor.setCursor(new Vector3())}>
          Reset cursor
        </Button>
      </div>
      <p className="z-hint">
        3D cursor:{' '}
        {editor.cursor
          .toArray()
          .map((v) => roundTo(v, 3))
          .join(', ')}{' '}
        — place it with the Cursor tool (C).
      </p>
    </Section>
  );
}
