import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Object3D } from 'three';
import { Editor } from '../../engine/editor/Editor';
import type { Viewport } from '../../engine/viewport/Viewport';
import { ProjectSession } from '../../storage/autosave';
import { projectRepository } from '../../storage/projectRepository';
import { clearSessionMarker } from '../../storage/session';
import { AddObjectsCommand } from '../../engine/history/commands/StructureCommands';
import { ROOT_ID, getId, isMesh } from '../../engine/scene/objectUtils';
import { importModelFiles, type ImportResult } from '../../formats/importModel';
import { IMPORT_ACCEPT } from '../../formats/detect';
import { pickFiles } from '../../platform/fileIO';
import { initNativeShell } from '../../platform/nativeShell';
import { describeError } from '../../utils/errors';
import { log } from '../../utils/logging';
import { useToast } from '../../components/ui/Toast';
import { Spinner } from '../../components/ui/Spinner';
import { Button } from '../../components/ui/Button';
import { useLayoutMode } from '../../app/useMediaLayout';
import { getPreferences } from '../../app/preferences';
import { createSampleScene } from '../../engine/scene/sampleScenes';
import { EditorContext, type DialogKind, type EditorContextValue, type EditorUi } from './EditorContext';
import { TopBar } from './TopBar';
import { ViewportPanel } from './ViewportPanel';
import { BottomToolbar } from './BottomToolbar';
import { installShortcuts } from './shortcuts';
import { HierarchyPanel } from '../hierarchy/HierarchyPanel';
import { Inspector } from '../inspector/Inspector';
import { ImportSummaryDialog } from '../import-export/ImportSummaryDialog';
import { ExportDialog } from '../import-export/ExportDialog';
import { WheelAssistantDialog } from '../mesh-editing/WheelAssistantDialog';
import { WheelPicker } from '../mesh-editing/WheelPicker';
import { PreferencesDialog } from '../settings/PreferencesDialog';
import { DiagnosticsDialog } from '../settings/DiagnosticsDialog';
import { ShortcutsDialog } from '../settings/ShortcutsDialog';

export interface EditorLaunch {
  projectId: string;
  /** Files to import right after opening (from the home screen). */
  importFiles?: File[];
  /** Populate a new project with the built-in sample scene. */
  sample?: boolean;
  versionId?: string;
}

interface Loaded {
  editor: Editor;
  session: ProjectSession;
  name: string;
}

export function EditorScreen({ launch, onExit }: { launch: EditorLaunch; onExit: () => void }) {
  const toast = useToast();
  const layout = useLayoutMode();
  const compact = layout !== 'desktop';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const [leftOpen, setLeftOpen] = useState(!compact);
  const [rightOpen, setRightOpen] = useState(!compact);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [additive, setAdditive] = useState(false);
  const [wheelPickerMesh, setWheelPickerMesh] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const pendingLaunch = useRef(launch);

  useEffect(() => {
    setLeftOpen(!compact);
    setRightOpen(!compact);
  }, [compact]);

  const onViewport = useCallback((vp: Viewport | null) => {
    viewportRef.current = vp;
    setViewport(vp);
  }, []);

  useEffect(() => {
    if (viewport) viewport.additive = additive;
  }, [viewport, additive]);

  // Create the editor + storage session for this project (once per launch).
  useEffect(() => {
    let cancelled = false;
    const editor = new Editor();
    let session: ProjectSession | null = null;
    (async () => {
      const record = await projectRepository.get(launch.projectId);
      if (!record) throw new Error('This project no longer exists.');
      session = new ProjectSession(editor, record.id, record.name, projectRepository, {
        debounceMs: getPreferences().autosaveSeconds * 1000,
        captureThumbnail: async () => viewportRef.current?.captureThumbnail() ?? null,
        editorState: () => {
          const cam = viewportRef.current?.getCameraState();
          return cam ? { camera: cam } : {};
        },
      });
      const warnings = await session.load(launch.versionId);
      if (cancelled) return;
      session.start();
      for (const w of warnings) toast.show('warning', w);
      setProjectName(record.name);
      setLoaded({ editor, session, name: record.name });
    })().catch((e) => {
      log.error('Failed to open project', e);
      if (!cancelled) setLoadError(describeError(e));
    });
    return () => {
      cancelled = true;
      const s = session;
      // Flush pending changes, then release GPU resources.
      void (s ? s.close() : Promise.resolve()).finally(() => editor.dispose());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.projectId, launch.versionId]);

  const editor = loaded?.editor;
  const session = loaded?.session;

  // Editor messages -> toasts.
  useEffect(() => editor?.onMessage((m) => toast.show(m.kind, m.text)), [editor, toast]);

  const importFiles = useCallback(
    async (files?: File[]) => {
      if (!editor) return;
      const list = files ?? (await pickFiles({ accept: IMPORT_ACCEPT, multiple: true }));
      if (list.length === 0) return;
      editor.setBusy(`Importing ${list[0].name}…`);
      try {
        const result = await importModelFiles(list, { renderer: viewportRef.current?.renderer });
        const cmd = new AddObjectsCommand(
          editor,
          [{ object: result.root as Object3D, parentId: ROOT_ID }],
          `Import ${result.fileName}`,
        );
        editor.execute(cmd);
        editor.select([getId(result.root)]);
        viewportRef.current?.frame([result.root]);
        setImportResult(result);
      } catch (e) {
        log.error('Import failed', e);
        toast.show('error', describeError(e));
      } finally {
        editor.setBusy(null);
      }
    },
    [editor, toast],
  );

  // Handle "import on open" / sample content once the viewport exists.
  useEffect(() => {
    if (!editor || !viewport) return;
    const l = pendingLaunch.current;
    pendingLaunch.current = { projectId: l.projectId };
    if (l.sample) {
      const objects = createSampleScene();
      editor.execute(
        new AddObjectsCommand(
          editor,
          objects.map((o) => ({ object: o, parentId: ROOT_ID })),
          'Add sample scene',
        ),
      );
      viewport.frame();
      void session?.save('create', true);
    } else if (l.importFiles?.length) {
      void importFiles(l.importFiles);
    } else {
      viewport.frame();
    }
  }, [editor, viewport, session, importFiles]);

  // Restore saved camera after load.
  useEffect(() => {
    if (!viewport || !session) return;
    void projectRepository.loadDocument(session.projectId).then(
      (d) => {
        const cam = d?.document.editor?.camera;
        if (cam) viewport.setCameraState(cam);
      },
      () => undefined,
    );
  }, [viewport, session]);

  const exit = useCallback(() => {
    if (editor?.busy) {
      toast.show('info', `Please wait: ${editor.busy}`);
      return;
    }
    // Unmounting the editor flushes unsaved changes before releasing resources.
    onExit();
  }, [editor, onExit, toast]);

  const ui: EditorUi = useMemo(
    () => ({
      openDialog: (kind) => setDialog(kind),
      importFiles,
      toggleLeft: () => {
        setLeftOpen((v) => !v);
        if (compact) setRightOpen(false);
      },
      toggleRight: () => {
        setRightOpen((v) => !v);
        if (compact) setLeftOpen(false);
      },
      exit,
      startWheelPicker: (meshId) => {
        setWheelPickerMesh(meshId);
        if (compact) {
          setLeftOpen(false);
          setRightOpen(false);
        }
      },
    }),
    [importFiles, exit, compact],
  );

  // Keyboard shortcuts, lifecycle flushes and native shell integration.
  useEffect(() => {
    if (!editor || !session) return;
    const uninstall = installShortcuts(editor, () => viewportRef.current, ui, session);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void session.flush();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (session.dirty || session.status.state === 'saving') {
        void session.flush();
        e.preventDefault();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onVisibility);
    window.addEventListener('beforeunload', onBeforeUnload);
    let removeNative: (() => void) | null = null;
    void initNativeShell({
      onBackground: () => void session.flush(),
      onBack: () => {
        if (editor.mode === 'edit') {
          editor.exitEditMode();
          return true;
        }
        exit();
        return true;
      },
    }).then((fn) => (removeNative = fn));
    return () => {
      uninstall();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
      removeNative?.();
    };
  }, [editor, session, ui, exit]);

  const renameProject = useCallback(
    (name: string) => {
      if (!session) return;
      setProjectName(name);
      session.rename(name);
      void projectRepository
        .rename(session.projectId, name)
        .catch((e) => toast.show('error', describeError(e)));
    },
    [session, toast],
  );

  if (loadError) {
    return (
      <div className="vp-fallback" style={{ position: 'fixed' }}>
        <div className="z-dialog" style={{ padding: 20, gap: 12 }}>
          <h2 style={{ margin: 0 }}>Could not open project</h2>
          <div className="z-error-box">{loadError}</div>
          <p className="z-hint">
            You can try restoring an earlier version from the project menu on the home screen.
          </p>
          <Button
            onClick={() => {
              clearSessionMarker();
              onExit();
            }}
          >
            Back to projects
          </Button>
        </div>
      </div>
    );
  }

  if (!loaded || !editor || !session) {
    return (
      <div className="vp-fallback" style={{ position: 'fixed' }}>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Spinner /> Opening project…
        </span>
      </div>
    );
  }

  const ctx: EditorContextValue = { editor, session, viewport, ui, projectName, renameProject };
  const importedMeshes: Object3D[] = [];
  importResult?.root.traverse((o) => {
    if (isMesh(o)) importedMeshes.push(o);
  });

  return (
    <EditorContext.Provider value={ctx}>
      <div
        className="editor"
        data-layout={compact ? 'compact' : 'full'}
        data-phone={layout === 'phone'}
        data-left={leftOpen ? 'open' : 'closed'}
        data-right={rightOpen ? 'open' : 'closed'}
      >
        <TopBar compact={layout === 'phone'} />
        <main className="editor-main">
          <aside className="sidepanel sidepanel--left" aria-label="Scene hierarchy">
            <HierarchyPanel />
          </aside>
          <ViewportPanel
            onViewport={onViewport}
            overlay={
              wheelPickerMesh ? (
                <WheelPicker meshId={wheelPickerMesh} onClose={() => setWheelPickerMesh(null)} />
              ) : null
            }
          />
          <aside className="sidepanel sidepanel--right" aria-label="Properties">
            <Inspector />
          </aside>
          <div
            className="drawer-backdrop"
            onClick={() => {
              setLeftOpen(false);
              setRightOpen(false);
            }}
          />
        </main>
        <BottomToolbar additive={additive} setAdditive={setAdditive} />
      </div>
      {importResult && (
        <ImportSummaryDialog
          result={importResult}
          onClose={() => setImportResult(null)}
          onSeparate={
            importedMeshes.length === 1
              ? () => {
                  editor.select([getId(importedMeshes[0])]);
                  setImportResult(null);
                  setDialog('wheels');
                }
              : undefined
          }
        />
      )}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === 'wheels' && <WheelAssistantDialog onClose={() => setDialog(null)} />}
      {dialog === 'preferences' && <PreferencesDialog onClose={() => setDialog(null)} />}
      {dialog === 'diagnostics' && <DiagnosticsDialog onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
    </EditorContext.Provider>
  );
}
