import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import type { ImportResult } from '../../formats/importModel';
import { formatBytes, formatCount } from '../../utils/format';

export function ImportSummaryDialog({
  result,
  onClose,
  onSeparate,
}: {
  result: ImportResult;
  onClose: () => void;
  onSeparate?: () => void;
}) {
  const s = result.stats;
  return (
    <Dialog
      title={`Imported ${result.fileName}`}
      onClose={onClose}
      footer={
        <>
          {onSeparate && <Button onClick={onSeparate}>Open wheel & parts assistant</Button>}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="import-summary">
        <div>
          <b>{formatBytes(result.fileSize)}</b>
          <span>{result.format.toUpperCase()} file</span>
        </div>
        <div>
          <b>{formatCount(s.objects)}</b>
          <span>Objects</span>
        </div>
        <div>
          <b>{formatCount(s.meshes)}</b>
          <span>Meshes</span>
        </div>
        <div>
          <b>{formatCount(s.materials)}</b>
          <span>Materials</span>
        </div>
        <div>
          <b>{formatCount(s.textures)}</b>
          <span>Textures</span>
        </div>
        <div>
          <b>{formatCount(s.triangles)}</b>
          <span>Triangles</span>
        </div>
      </div>
      {result.generator && <p className="z-hint">Created with: {result.generator}</p>}
      {result.warnings.length > 0 && (
        <ul className="z-warning-list">
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <p className="z-hint">The model was parsed on this device; nothing was uploaded.</p>
    </Dialog>
  );
}
