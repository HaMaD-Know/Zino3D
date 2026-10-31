import { useEffect, useState } from 'react';
import {
  Activity,
  Box,
  Download,
  EllipsisVertical,
  Eye,
  Grid3x3,
  House,
  Keyboard,
  PanelLeft,
  PanelRight,
  Redo2,
  Save,
  Settings,
  Undo2,
  Upload,
} from 'lucide-react';
import { IconButton } from '../../components/ui/Button';
import { MenuButton, type MenuEntry } from '../../components/ui/Menu';
import { useEditorChannels, useEditorContext } from './EditorContext';
import type { SessionStatus } from '../../storage/autosave';
import { getPreferences, updatePreferences } from '../../app/preferences';
import { projectRepository } from '../../storage/projectRepository';
import { saveFile } from '../../platform/fileIO';
import { describeError } from '../../utils/errors';
import type { NamedView } from '../../engine/viewport/Viewport';

function SaveStatus({ status }: { status: SessionStatus }) {
  const text =
    status.state === 'saving'
      ? 'Saving…'
      : status.state === 'pending'
        ? 'Unsaved changes'
        : status.state === 'error'
          ? 'Save failed'
          : status.lastSavedAt
            ? 'Saved'
            : 'Not saved yet';
  return (
    <span
      className={`save-status save-status--${status.state}`}
      title={
        status.error ??
        (status.lastSavedAt ? `Last saved ${new Date(status.lastSavedAt).toLocaleTimeString()}` : '')
      }
      role="status"
    >
      <span className="save-status__dot" />
      <span className="save-status__text">{text}</span>
    </span>
  );
}

export function TopBar({ compact }: { compact: boolean }) {
  const { editor, session, viewport, ui, projectName, renameProject } = useEditorContext();
  useEditorChannels(editor, ['history', 'selection']);
  const [status, setStatus] = useState(session.status);
  const [editing, setEditing] = useState(false);
  useEffect(() => session.onStatus(setStatus), [session]);

  const viewEntries = (): MenuEntry[] => {
    const views: NamedView[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];
    const prefs = getPreferences();
    return [
      { kind: 'label', label: 'Camera' },
      {
        label: viewport?.projection === 'perspective' ? 'Switch to orthographic' : 'Switch to perspective',
        icon: Eye,
        shortcut: '5',
        onSelect: () =>
          viewport?.setProjection(viewport.projection === 'perspective' ? 'orthographic' : 'perspective'),
      },
      {
        label: 'Frame selected',
        icon: Box,
        shortcut: 'F',
        onSelect: () => viewport?.frame(editor.selectedObjects()),
      },
      { label: 'Frame all', shortcut: 'Home', onSelect: () => viewport?.frame() },
      { kind: 'separator' },
      ...views.map((v) => ({
        label: `${v[0].toUpperCase()}${v.slice(1)} view`,
        onSelect: () => viewport?.setView(v),
      })),
      { kind: 'separator' },
      {
        label: prefs.viewport.showGrid ? 'Hide grid' : 'Show grid',
        icon: Grid3x3,
        onSelect: () =>
          updatePreferences({ viewport: { ...prefs.viewport, showGrid: !prefs.viewport.showGrid } }),
      },
    ];
  };

  const moreEntries = (): MenuEntry[] => [
    { label: 'Back to projects', icon: House, onSelect: ui.exit },
    { kind: 'separator' },
    ...(compact
      ? ([
          { label: 'Import 3D model', icon: Upload, onSelect: () => void ui.importFiles() },
          { label: 'Export…', icon: Download, onSelect: () => ui.openDialog('export') },
          { label: 'Frame all', icon: Box, onSelect: () => viewport?.frame() },
          { kind: 'separator' },
        ] satisfies MenuEntry[])
      : []),
    { label: 'Save now', icon: Save, shortcut: 'Ctrl+S', onSelect: () => void session.save('manual', true) },
    {
      label: 'Download project file (.zino3d)',
      icon: Download,
      onSelect: async () => {
        try {
          await session.save('manual');
          const { blob, name } = await projectRepository.exportBundle(session.projectId);
          await saveFile(blob, `${name}.zino3d`);
        } catch (error) {
          editor.message('error', describeError(error));
        }
      },
    },
    { kind: 'separator' },
    { label: 'Diagnostics', icon: Activity, onSelect: () => ui.openDialog('diagnostics') },
    { label: 'Keyboard shortcuts', icon: Keyboard, onSelect: () => ui.openDialog('shortcuts') },
    { label: 'Preferences', icon: Settings, onSelect: () => ui.openDialog('preferences') },
  ];

  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar__home"
        onClick={ui.exit}
        aria-label="Back to projects"
        title="Back to projects"
      >
        <House size={17} aria-hidden />
        <span className="hide-phone">Projects</span>
      </button>
      <button
        type="button"
        className="topbar__brand hide-phone"
        onClick={ui.exit}
        title="Back to projects"
        tabIndex={-1}
      >
        <img src="./icons/zino3d.svg" alt="" />
        <b className="hide-phone">Zino3D</b>
      </button>
      <div className="topbar__project">
        {editing ? (
          <input
            className="z-input"
            style={{ width: 200 }}
            aria-label="Project name"
            defaultValue={projectName}
            autoFocus
            onBlur={(e) => {
              setEditing(false);
              if (e.target.value.trim()) renameProject(e.target.value.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="topbar__name"
            onClick={() => setEditing(true)}
            title="Rename project"
          >
            {projectName}
          </button>
        )}
        <SaveStatus status={status} />
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__group">
        <IconButton
          icon={Undo2}
          label={editor.history.undoLabel ? `Undo ${editor.history.undoLabel}` : 'Undo'}
          shortcut="Ctrl+Z"
          disabled={!editor.history.canUndo}
          onClick={() => editor.undo()}
        />
        <IconButton
          icon={Redo2}
          label={editor.history.redoLabel ? `Redo ${editor.history.redoLabel}` : 'Redo'}
          shortcut="Ctrl+Shift+Z"
          disabled={!editor.history.canRedo}
          onClick={() => editor.redo()}
        />
        {!compact && (
          <>
            <span className="topbar__sep" />
            <IconButton
              icon={Upload}
              label="Import 3D model"
              shortcut="Ctrl+I"
              onClick={() => void ui.importFiles()}
            />
            <IconButton
              icon={Download}
              label="Export"
              shortcut="Ctrl+E"
              onClick={() => ui.openDialog('export')}
            />
            <MenuButton
              entries={viewEntries}
              render={(open) => <IconButton icon={Eye} label="View" onClick={(e) => open(e.currentTarget)} />}
            />
            <span className="topbar__sep" />
          </>
        )}
        <IconButton icon={PanelLeft} label="Scene hierarchy" onClick={ui.toggleLeft} />
        <IconButton icon={PanelRight} label="Properties" onClick={ui.toggleRight} />
        <MenuButton
          entries={moreEntries}
          render={(open) => (
            <IconButton icon={EllipsisVertical} label="More" onClick={(e) => open(e.currentTarget)} />
          )}
        />
      </div>
    </header>
  );
}
