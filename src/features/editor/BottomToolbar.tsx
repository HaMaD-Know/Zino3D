import {
  Box,
  Car,
  Copy,
  Crosshair,
  Dot,
  Globe,
  Group,
  Link,
  Magnet,
  Minus,
  MousePointer2,
  Move,
  Rotate3d,
  Scale3d,
  Scissors,
  SquareDashed,
  SquareMousePointer,
  Trash,
  Triangle,
  Repeat2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { IconButton } from '../../components/ui/Button';
import { useEditorChannels, useEditorContext } from './EditorContext';
import type { TransformTool } from '../../engine/editor/Editor';
import type { ElementMode } from '../../engine/geometry/topology';
import { deleteSelected, duplicateSelected, groupSelected } from '../../engine/editor/objectOperations';
import {
  deleteElements,
  separateElementSelection,
  separateLooseParts,
} from '../../engine/editor/meshOperations';
import {
  getTopology,
  invertElementSelection,
  selectAllElements,
  selectLinked,
  selectionSize,
} from '../../engine/geometry/topology';
import { isMesh } from '../../engine/scene/objectUtils';
import { useState } from 'react';
import { formatCount } from '../../utils/format';

function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon: LucideIcon; shortcut?: string; disabled?: boolean }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg__btn"
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.shortcut ? `${o.label} (${o.shortcut})` : o.label}
          onClick={() => onChange(o.value)}
        >
          <o.icon size={15} aria-hidden />
          <span className="seg__label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function BottomToolbar({
  additive,
  setAdditive,
}: {
  additive: boolean;
  setAdditive: (v: boolean) => void;
}) {
  const { editor, ui } = useEditorContext();
  useEditorChannels(editor, ['mode', 'settings', 'selection', 'edit', 'scene']);
  const [busy, setBusy] = useState(false);
  const active = editor.activeObject();
  const s = editor.settings;
  const target = editor.editTarget();
  const run = async (fn: () => unknown) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const topo = target ? getTopology(target.geometry) : null;
  const elementCount = topo ? selectionSize(editor.elementMode, editor.elementSelection) : 0;

  return (
    <footer className="bottombar" aria-label="Tools">
      <Seg
        label="Mode"
        value={editor.mode}
        onChange={(m) => (m === 'edit' ? editor.enterEditMode() : editor.exitEditMode())}
        options={[
          { value: 'object', label: 'Object', icon: Box, shortcut: 'Tab' },
          {
            value: 'edit',
            label: 'Edit',
            icon: Triangle,
            shortcut: 'Tab',
            disabled: editor.mode === 'object' && !isMesh(active),
          },
        ]}
      />
      {editor.mode === 'edit' && (
        <Seg<ElementMode>
          label="Element"
          value={editor.elementMode}
          onChange={(m) => editor.setElementMode(m)}
          options={[
            { value: 'vertex', label: 'Vertex', icon: Dot, shortcut: '1' },
            { value: 'edge', label: 'Edge', icon: Minus, shortcut: '2' },
            { value: 'face', label: 'Face', icon: Triangle, shortcut: '3' },
          ]}
        />
      )}
      <span className="bottombar__sep" />
      <Seg<TransformTool>
        label="Tool"
        value={s.tool}
        onChange={(tool) => editor.updateSettings({ tool })}
        options={[
          { value: 'select', label: 'Select', icon: MousePointer2, shortcut: 'Q' },
          { value: 'translate', label: 'Move', icon: Move, shortcut: 'W' },
          {
            value: 'rotate',
            label: 'Rotate',
            icon: Rotate3d,
            shortcut: 'E',
            disabled: editor.mode === 'edit',
          },
          { value: 'scale', label: 'Scale', icon: Scale3d, shortcut: 'R', disabled: editor.mode === 'edit' },
          { value: 'cursor', label: 'Cursor', icon: Crosshair, shortcut: 'C' },
        ]}
      />
      <div className="bottombar__actions">
        <IconButton
          icon={Magnet}
          label={s.snapEnabled ? 'Snapping on' : 'Snapping off'}
          pressed={s.snapEnabled}
          onClick={() => editor.updateSettings({ snapEnabled: !s.snapEnabled })}
        />
        <IconButton
          icon={Globe}
          label={s.space === 'world' ? 'World space' : 'Local space'}
          pressed={s.space === 'local'}
          onClick={() => editor.updateSettings({ space: s.space === 'world' ? 'local' : 'world' })}
        />
        <IconButton
          icon={SquareMousePointer}
          label={additive ? 'Multi-select on (taps add to selection)' : 'Multi-select off'}
          pressed={additive}
          onClick={() => setAdditive(!additive)}
        />
      </div>
      <span className="bottombar__sep" />
      {editor.mode === 'object' ? (
        <div className="bottombar__actions">
          <IconButton
            icon={Copy}
            label="Duplicate"
            shortcut="Ctrl+D"
            disabled={!editor.selection.length}
            onClick={() => duplicateSelected(editor)}
          />
          <IconButton
            icon={Group}
            label="Group"
            shortcut="Ctrl+G"
            disabled={!editor.selection.length}
            onClick={() => groupSelected(editor)}
          />
          <IconButton
            icon={Scissors}
            label="Separate by loose parts"
            shortcut="P"
            disabled={!isMesh(active) || busy}
            onClick={() => void run(() => separateLooseParts(editor))}
          />
          <IconButton
            icon={Car}
            label="Wheel & parts assistant"
            disabled={!isMesh(active)}
            onClick={() => ui.openDialog('wheels')}
          />
          <IconButton
            icon={Trash}
            label="Delete"
            shortcut="Del"
            disabled={!editor.selection.length}
            onClick={() => deleteSelected(editor)}
          />
        </div>
      ) : (
        topo && (
          <div className="bottombar__actions">
            <IconButton
              icon={SquareDashed}
              label="Select all / none"
              shortcut="A"
              onClick={() =>
                editor.setElementSelection(
                  elementCount
                    ? { vertices: new Set(), edges: new Set(), faces: new Set() }
                    : selectAllElements(topo, editor.elementMode),
                )
              }
            />
            <IconButton
              icon={Link}
              label="Select linked"
              shortcut="L"
              disabled={!elementCount}
              onClick={() =>
                editor.setElementSelection(selectLinked(topo, editor.elementMode, editor.elementSelection))
              }
            />
            <IconButton
              icon={Repeat2}
              label="Invert selection"
              shortcut="Ctrl+I"
              onClick={() =>
                editor.setElementSelection(
                  invertElementSelection(topo, editor.elementMode, editor.elementSelection),
                )
              }
            />
            <IconButton
              icon={Scissors}
              label="Separate selection into new object"
              shortcut="P"
              disabled={!elementCount}
              onClick={() => separateElementSelection(editor, 'move')}
            />
            <IconButton
              icon={Copy}
              label="Duplicate selection into new object"
              shortcut="Shift+D"
              disabled={!elementCount}
              onClick={() => separateElementSelection(editor, 'copy')}
            />
            <IconButton
              icon={Trash}
              label="Delete selection"
              shortcut="Del"
              disabled={!elementCount}
              onClick={() => deleteElements(editor)}
            />
          </div>
        )
      )}
      <span className="bottombar__info">
        {editor.mode === 'edit' && topo
          ? `${formatCount(elementCount)} ${editor.elementMode}(s) selected · ${formatCount(topo.triangleCount)} tris · ${topo.connectivity.componentCount} part(s)`
          : `${editor.selection.length} selected`}
      </span>
    </footer>
  );
}
