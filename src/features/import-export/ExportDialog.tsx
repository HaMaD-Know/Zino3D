import { useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { FieldRow, Toggle } from '../../components/ui/Fields';
import { Spinner } from '../../components/ui/Spinner';
import { useEditorContext } from '../editor/EditorContext';
import { type ExportFormat, exportModel } from '../../formats/exportModel';
import { saveFile } from '../../platform/fileIO';
import { describeError } from '../../utils/errors';
import { formatBytes } from '../../utils/format';
import { getPreferences } from '../../app/preferences';

const FORMATS: Array<{ value: ExportFormat; label: string; note: string }> = [
  {
    value: 'glb',
    label: 'GLB (binary glTF)',
    note: 'Recommended. Keeps hierarchy, names, transforms, PBR materials and textures in one file.',
  },
  {
    value: 'gltf',
    label: 'glTF (JSON, embedded)',
    note: 'Same content as GLB as readable JSON with embedded data (larger).',
  },
  {
    value: 'obj',
    label: 'OBJ',
    note: 'Geometry, normals, UVs and object names only. No materials, textures or hierarchy.',
  },
  {
    value: 'stl',
    label: 'STL (binary)',
    note: 'Triangles only, for 3D printing. No materials, UVs or hierarchy.',
  },
];

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { editor, projectName } = useEditorContext();
  const [format, setFormat] = useState<ExportFormat>('glb');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [onlyVisible, setOnlyVisible] = useState(true);
  const [limitTextures, setLimitTextures] = useState(false);
  const [name, setName] = useState(projectName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ size: number; warnings: string[]; outcome: string } | null>(null);
  const hasSelection = editor.selection.length > 0;

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const objects = selectedOnly && hasSelection ? editor.topLevelSelection() : editor.root.children;
      const r = await exportModel({
        format,
        objects,
        onlyVisible,
        fileName: name || 'zino3d-export',
        maxTextureSize: limitTextures ? getPreferences().exportMaxTextureSize : undefined,
      });
      const outcome = await saveFile(r.blob, r.fileName);
      if (outcome === 'cancelled') {
        setResult(null);
        return;
      }
      setResult({ size: r.blob.size, warnings: r.warnings, outcome });
      editor.message('success', `Exported ${r.fileName} (${formatBytes(r.blob.size)}).`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Export model"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </>
      }
    >
      <FieldRow label="File name">
        <input
          className="z-input"
          aria-label="File name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Format">
        <select
          className="z-select"
          aria-label="Export format"
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportFormat)}
        >
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </FieldRow>
      <p className="z-hint">{FORMATS.find((f) => f.value === format)?.note}</p>
      <Toggle
        label={`Selected objects only${hasSelection ? ` (${editor.topLevelSelection().length})` : ' (nothing selected)'}`}
        checked={selectedOnly && hasSelection}
        disabled={!hasSelection}
        onChange={setSelectedOnly}
      />
      <Toggle label="Skip hidden objects" checked={onlyVisible} onChange={setOnlyVisible} />
      {(format === 'glb' || format === 'gltf') && (
        <Toggle
          label={`Limit textures to ${getPreferences().exportMaxTextureSize}px (smaller files for mobile)`}
          checked={limitTextures}
          onChange={setLimitTextures}
        />
      )}
      <p className="z-hint">
        Separate objects (for example wheels split from a car body) are exported as separate nodes with their
        own transforms.
      </p>
      {error && (
        <div className="z-error-box" role="alert">
          {error}
        </div>
      )}
      {result && (
        <div className="callout">
          {result.outcome === 'shared' ? 'Shared' : result.outcome === 'saved' ? 'Saved' : 'Downloaded'} ·{' '}
          {formatBytes(result.size)}. The file was validated after export.
        </div>
      )}
      {result && result.warnings.length > 0 && (
        <ul className="z-warning-list">
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
