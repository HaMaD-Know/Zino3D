import { Section } from '../../components/ui/Section';
import { TextField, Toggle } from '../../components/ui/Fields';
import { useEditorChannels, useEditorContext } from '../editor/EditorContext';
import { displayType, getId, isMesh } from '../../engine/scene/objectUtils';
import { renameObject, setLocked, setVisibility } from '../../engine/editor/objectOperations';
import { computeSceneStats } from '../../formats/sceneStats';
import { formatBytes, formatCount } from '../../utils/format';
import { TransformSection } from './TransformSection';
import { MeshSection } from './MeshSection';
import { MaterialSection } from './MaterialSection';

function SceneSummary() {
  const { editor } = useEditorContext();
  useEditorChannels(editor, ['scene']);
  const stats = computeSceneStats(editor.root.children);
  return (
    <>
      <div className="insp-empty">
        Select an object in the viewport or the scene list to edit its properties.
      </div>
      <Section title="Scene">
        <dl className="z-stats">
          <dt>Objects</dt>
          <dd>{formatCount(stats.objects)}</dd>
          <dt>Meshes</dt>
          <dd>{formatCount(stats.meshes)}</dd>
          <dt>Triangles</dt>
          <dd>{formatCount(stats.triangles)}</dd>
          <dt>Vertices</dt>
          <dd>{formatCount(stats.vertices)}</dd>
          <dt>Materials</dt>
          <dd>{formatCount(stats.materials)}</dd>
          <dt>Textures</dt>
          <dd>{formatCount(stats.textures)}</dd>
          <dt>Geometry data</dt>
          <dd>{formatBytes(stats.geometryBytes)}</dd>
        </dl>
      </Section>
    </>
  );
}

export function Inspector() {
  const { editor } = useEditorContext();
  useEditorChannels(editor, ['selection', 'scene']);
  const object = editor.activeObject();
  const count = editor.selection.length;
  return (
    <>
      <div className="sidepanel__head">
        <h2>Properties</h2>
        {count > 1 && <span className="z-badge z-badge--accent">{count} selected</span>}
      </div>
      <div className="sidepanel__scroll">
        {!object ? (
          <SceneSummary />
        ) : (
          <>
            <div className="insp-title">
              <TextField
                label="Object name"
                value={object.name}
                disabled={editor.isLocked(object)}
                onCommit={(v) => renameObject(editor, getId(object), v)}
              />
              <span className="z-badge">{displayType(object)}</span>
            </div>
            {count > 1 && (
              <div className="callout" style={{ margin: 10 }}>
                Showing the active (last selected) object. Gizmo edits move all selected objects together.
              </div>
            )}
            <TransformSection object={object} />
            <Section title="Object">
              <Toggle
                label="Visible"
                checked={object.visible}
                onChange={(v) => setVisibility(editor, [getId(object)], v)}
              />
              <Toggle
                label="Locked (prevent editing)"
                checked={object.userData.zinoLocked === true}
                onChange={(v) => setLocked(editor, [getId(object)], v)}
              />
              {editor.isLocked(object) && object.userData.zinoLocked !== true && (
                <p className="z-hint">Locked because a parent is locked.</p>
              )}
              <dl className="z-stats">
                <dt>Children</dt>
                <dd>{object.children.length}</dd>
                <dt>Parent</dt>
                <dd>{object.parent === editor.root ? 'Scene' : object.parent?.name || '—'}</dd>
                <dt>ID</dt>
                <dd style={{ fontFamily: 'var(--z-mono)', fontSize: 10 }}>{getId(object)}</dd>
              </dl>
            </Section>
            {isMesh(object) && <MeshSection mesh={object} />}
            {isMesh(object) && <MaterialSection mesh={object} />}
          </>
        )}
      </div>
    </>
  );
}
