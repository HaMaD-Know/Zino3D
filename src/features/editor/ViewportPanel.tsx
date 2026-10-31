import { useEffect, useRef, useState } from 'react';
import { Box, Focus, Layers, Upload } from 'lucide-react';
import { Viewport } from '../../engine/viewport/Viewport';
import { useEditorChannels, useEditorContext } from './EditorContext';
import { usePreferences } from '../../app/preferences';
import { Button, IconButton } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { describeError } from '../../utils/errors';

export function ViewportPanel({ onViewport }: { onViewport: (v: Viewport | null) => void }) {
  const { editor, viewport, ui } = useEditorContext();
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [dragging, setDragging] = useState(false);
  const prefs = usePreferences();
  useEditorChannels(editor, ['scene', 'mode', 'status', 'edit', 'selection']);

  // Exactly one renderer per mounted panel; fully disposed on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let vp: Viewport | null = null;
    try {
      vp = new Viewport(editor, host, prefs.viewport);
      vp.onContextLost = setContextLost;
      onViewport(vp);
    } catch (e) {
      setError(describeError(e));
    }
    return () => {
      onViewport(null);
      vp?.dispose();
    };
    // Renderer options that need a new context (antialias) apply on next open; others apply live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    viewport?.applyOptions(prefs.viewport);
  }, [viewport, prefs.viewport]);

  const empty = editor.root.children.length === 0;
  const target = editor.editTarget();

  return (
    <div
      className="viewport-wrap"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) void ui.importFiles(files);
      }}
    >
      <div ref={hostRef} className="viewport-host" />
      {error && (
        <div className="vp-fallback">
          <div className="z-error-box" role="alert" style={{ maxWidth: 420 }}>
            <b>3D viewport unavailable.</b> {error}
            <p className="z-hint">You can still manage, import, export and back up projects.</p>
          </div>
        </div>
      )}
      {contextLost && (
        <div className="viewport-overlay viewport-overlay--tr" style={{ top: 48 }}>
          <div className="vp-busy" role="alert">
            Graphics context lost — restoring…
          </div>
        </div>
      )}
      {!error && (
        <div className="viewport-overlay viewport-overlay--tl">
          <span className={`mode-badge ${editor.mode === 'edit' ? 'mode-badge--edit' : ''}`}>
            <Layers size={12} />
            {editor.mode === 'edit'
              ? `Edit Mode · ${target?.name || 'Mesh'} · ${editor.elementMode}`
              : 'Object Mode'}
          </span>
          <span className="vp-chip">
            <IconButton
              icon={Focus}
              label="Frame selected"
              shortcut="F"
              onClick={() => viewport?.frame(editor.selectedObjects())}
              disabled={editor.selection.length === 0}
            />
            <IconButton icon={Box} label="Frame all" shortcut="Home" onClick={() => viewport?.frame()} />
            <select
              className="z-select"
              aria-label="Projection"
              value={viewport?.projection ?? 'perspective'}
              onChange={(e) => {
                viewport?.setProjection(e.target.value as 'perspective' | 'orthographic');
                editor.notify('settings');
              }}
            >
              <option value="perspective">Persp</option>
              <option value="orthographic">Ortho</option>
            </select>
          </span>
          {editor.busy && (
            <span className="vp-busy" role="status">
              <Spinner /> {editor.busy}
            </span>
          )}
        </div>
      )}
      {empty && !error && (
        <div className="vp-empty">
          <div className="vp-empty__card">
            <Upload size={28} color="var(--z-accent)" />
            <b>Import a 3D model</b>
            <p>GLB, glTF (with .bin and textures), OBJ + MTL, STL or FBX. Files stay on this device.</p>
            <Button variant="primary" icon={Upload} onClick={() => void ui.importFiles()}>
              Choose files…
            </Button>
            <p className="z-hint">or drag & drop files here</p>
          </div>
        </div>
      )}
      {dragging && <div className="vp-drop">Drop to import</div>}
    </div>
  );
}
