import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Editor } from '../../engine/editor/Editor';
import type { EditorChannel } from '../../engine/history/commands/types';
import type { Viewport } from '../../engine/viewport/Viewport';
import type { ProjectSession } from '../../storage/autosave';

export type DialogKind = 'export' | 'wheels' | 'diagnostics' | 'preferences' | 'shortcuts' | 'weld';

export interface EditorUi {
  openDialog: (kind: DialogKind) => void;
  importFiles: (files?: File[]) => Promise<void>;
  toggleLeft: () => void;
  toggleRight: () => void;
  exit: () => void;
  /** Opens the floating wheel picker for wheels fused into a mesh. */
  startWheelPicker: (meshId: string) => void;
}

export interface EditorContextValue {
  editor: Editor;
  session: ProjectSession;
  viewport: Viewport | null;
  ui: EditorUi;
  projectName: string;
  renameProject: (name: string) => void;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditorContext must be used inside <EditorContext.Provider>');
  return ctx;
}

/** Re-renders the calling component when any of the given editor channels change. */
export function useEditorChannels(editor: Editor, channels: EditorChannel[]): string {
  return useSyncExternalStore(
    (cb) =>
      editor.subscribe((changed) => {
        if (changed.some((c) => channels.includes(c))) cb();
      }),
    () => channels.map((c) => editor.version(c)).join(':'),
  );
}
