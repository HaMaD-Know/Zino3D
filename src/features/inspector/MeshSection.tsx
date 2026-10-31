import { useMemo, useState } from 'react';
import type { Mesh } from 'three';
import { Car, Scissors } from 'lucide-react';
import { Section } from '../../components/ui/Section';
import { Button } from '../../components/ui/Button';
import { NumberInput, FieldRow } from '../../components/ui/Fields';
import { useEditorChannels, useEditorContext } from '../editor/EditorContext';
import { analyzeGeometry, type GeometryDiagnostics } from '../../engine/geometry/analysis';
import { triangleCount } from '../../engine/geometry/attributes';
import { applyMeshUtility, separateLooseParts } from '../../engine/editor/meshOperations';
import { formatBytes, formatCount } from '../../utils/format';

const AUTO_ANALYZE_LIMIT = 250_000;

export function MeshSection({ mesh }: { mesh: Mesh }) {
  const { editor, ui } = useEditorContext();
  useEditorChannels(editor, ['scene', 'edit']);
  const geometry = mesh.geometry;
  const tris = triangleCount(geometry);
  const [requested, setRequested] = useState<object | null>(null);
  const [tolerance, setTolerance] = useState<number | null>(null);
  const diag: GeometryDiagnostics | null = useMemo(
    () => (tris <= AUTO_ANALYZE_LIMIT || requested === geometry ? analyzeGeometry(geometry) : null),
    [geometry, tris, requested],
  );
  const locked = editor.isLocked(mesh);
  const tol = tolerance ?? diag?.tolerance ?? 1e-5;
  const skinned = (mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;

  return (
    <Section title="Mesh">
      <dl className="z-stats">
        <dt>Triangles</dt>
        <dd>{formatCount(tris)}</dd>
        <dt>Vertices</dt>
        <dd>{formatCount(geometry.getAttribute('position')?.count ?? 0)}</dd>
        <dt>Indexed</dt>
        <dd>{geometry.index ? 'yes' : 'no'}</dd>
        <dt>Material groups</dt>
        <dd>{geometry.groups.length || 1}</dd>
        <dt>Attributes</dt>
        <dd title={Object.keys(geometry.attributes).join(', ')}>
          {Object.keys(geometry.attributes).join(', ')}
        </dd>
        {diag && (
          <>
            <dt>UV coordinates</dt>
            <dd>{diag.hasUVs ? 'yes' : 'none'}</dd>
            <dt>Loose parts</dt>
            <dd>{formatCount(diag.componentCount)}</dd>
            <dt>Open (boundary) edges</dt>
            <dd>{formatCount(diag.boundaryEdges)}</dd>
            <dt>Non-manifold edges</dt>
            <dd>{formatCount(diag.nonManifoldEdges)}</dd>
            <dt>Degenerate triangles</dt>
            <dd>{formatCount(diag.degenerateTriangles)}</dd>
            <dt>Closed surface</dt>
            <dd>{diag.closed ? 'yes' : 'no'}</dd>
            <dt>GPU memory (approx.)</dt>
            <dd>{formatBytes(diag.approximateBytes)}</dd>
          </>
        )}
      </dl>
      {!diag && (
        <Button size="sm" onClick={() => setRequested(geometry)}>
          Analyze topology ({formatCount(tris)} triangles)
        </Button>
      )}
      {skinned && (
        <div className="callout callout--warn">
          Skinned mesh: geometry editing is disabled to avoid breaking its rig.
        </div>
      )}
      {diag && diag.componentCount > 1 && !skinned && (
        <div className="callout">
          This mesh has {diag.componentCount} disconnected parts. You can split them into separate objects, or
          use the wheel assistant to pick parts.
        </div>
      )}
      <div className="z-btn-grid">
        <Button
          size="sm"
          icon={Scissors}
          disabled={locked || skinned}
          onClick={() => void separateLooseParts(editor)}
        >
          Separate parts
        </Button>
        <Button size="sm" icon={Car} disabled={locked || skinned} onClick={() => ui.openDialog('wheels')}>
          Wheel assistant
        </Button>
        <Button
          size="sm"
          disabled={locked || skinned}
          onClick={() => applyMeshUtility(editor, 'normals-smooth')}
        >
          Normals: smooth
        </Button>
        <Button
          size="sm"
          disabled={locked || skinned}
          onClick={() => applyMeshUtility(editor, 'normals-flat')}
        >
          Normals: flat
        </Button>
        <Button
          size="sm"
          disabled={locked || skinned}
          onClick={() => applyMeshUtility(editor, 'flip-normals')}
        >
          Flip normals
        </Button>
        <Button
          size="sm"
          disabled={locked || skinned}
          onClick={() => applyMeshUtility(editor, 'cleanup', tol)}
        >
          Clean up
        </Button>
      </div>
      <FieldRow label="Weld distance">
        <div style={{ display: 'flex', gap: 6 }}>
          <NumberInput
            label="Weld tolerance"
            value={tol}
            precision={7}
            step={tol}
            min={0}
            onCommit={setTolerance}
          />
          <Button
            size="sm"
            disabled={locked || skinned}
            onClick={() => applyMeshUtility(editor, 'weld', tol)}
          >
            Weld
          </Button>
        </div>
      </FieldRow>
      <p className="z-hint">
        Weld merges vertices whose position, normal and UV all match within the distance, so UV seams are
        kept. Clean up removes degenerate triangles and unused vertices.
      </p>
    </Section>
  );
}
