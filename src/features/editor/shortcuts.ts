import type { Editor } from '../../engine/editor/Editor';
import type { Viewport } from '../../engine/viewport/Viewport';
import type { EditorUi } from './EditorContext';
import {
  deleteSelected,
  duplicateSelected,
  groupSelected,
  setVisibility,
  showAll,
  ungroupSelected,
} from '../../engine/editor/objectOperations';
import {
  deleteElements,
  separateElementSelection,
  separateLooseParts,
} from '../../engine/editor/meshOperations';
import {
  emptyElementSelection,
  getTopology,
  invertElementSelection,
  selectAllElements,
  selectLinked,
  selectionSize,
} from '../../engine/geometry/topology';
import type { ProjectSession } from '../../storage/autosave';

export const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + Shift + Z, Ctrl + Y', 'Redo'],
  ['Ctrl/Cmd + S', 'Save now'],
  ['Ctrl/Cmd + I', 'Import (object mode) · Invert selection (edit mode)'],
  ['Ctrl/Cmd + E', 'Export'],
  ['Tab', 'Toggle Object / Edit Mode'],
  ['1 / 2 / 3', 'Vertex / Edge / Face selection (Edit Mode)'],
  ['Q / W / E / R', 'Select / Move / Rotate / Scale tool'],
  ['C', '3D cursor tool'],
  ['A', 'Select all (again: deselect)'],
  ['Alt + A', 'Deselect all'],
  ['L', 'Select linked (Edit Mode)'],
  ['P', 'Separate (loose parts / selection)'],
  ['Shift + D', 'Duplicate selection (Edit Mode)'],
  ['Ctrl/Cmd + D', 'Duplicate objects'],
  ['Ctrl/Cmd + G / Ctrl+Shift+G', 'Group / Ungroup'],
  ['Delete / Backspace / X', 'Delete'],
  ['H / Alt + H', 'Hide selected / Show all'],
  ['F', 'Frame selected'],
  ['Home', 'Frame all'],
  ['5', 'Toggle perspective / orthographic'],
  ['Shift + click', 'Add to / toggle selection'],
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  );
}

export function installShortcuts(
  editor: Editor,
  getViewport: () => Viewport | null,
  ui: EditorUi,
  session: ProjectSession,
): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target) || document.querySelector('.z-dialog-backdrop')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const vp = getViewport();
    const edit = editor.mode === 'edit';
    const target = editor.editTarget();
    const topo = edit && target ? getTopology(target.geometry) : null;
    let handled = true;
    if (mod && key === 'z' && !e.shiftKey) editor.undo();
    else if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) editor.redo();
    else if (mod && key === 's') void session.save('manual', true);
    else if (mod && key === 'e') ui.openDialog('export');
    else if (mod && key === 'i') {
      if (topo)
        editor.setElementSelection(invertElementSelection(topo, editor.elementMode, editor.elementSelection));
      else void ui.importFiles();
    } else if (mod && key === 'd' && !edit) duplicateSelected(editor);
    else if (mod && key === 'g') (e.shiftKey ? ungroupSelected : groupSelected)(editor);
    else if (mod) handled = false;
    else if (key === 'tab') {
      if (edit) editor.exitEditMode();
      else editor.enterEditMode();
    } else if (edit && (key === '1' || key === '2' || key === '3'))
      editor.setElementMode(key === '1' ? 'vertex' : key === '2' ? 'edge' : 'face');
    else if (key === 'q') editor.updateSettings({ tool: 'select' });
    else if (key === 'w' || key === 'g') editor.updateSettings({ tool: 'translate' });
    else if (key === 'e' && !edit) editor.updateSettings({ tool: 'rotate' });
    else if ((key === 'r' || key === 's') && !edit) editor.updateSettings({ tool: 'scale' });
    else if (key === 'c') editor.updateSettings({ tool: 'cursor' });
    else if (key === 'a' && e.altKey) {
      if (topo) editor.setElementSelection(emptyElementSelection());
      else editor.clearSelection();
    } else if (key === 'a') {
      if (topo) {
        editor.setElementSelection(
          selectionSize(editor.elementMode, editor.elementSelection)
            ? emptyElementSelection()
            : selectAllElements(topo, editor.elementMode),
        );
      } else if (editor.selection.length) editor.clearSelection();
      else editor.selectAll();
    } else if (key === 'l' && topo)
      editor.setElementSelection(selectLinked(topo, editor.elementMode, editor.elementSelection));
    else if (key === 'p') {
      if (edit) separateElementSelection(editor, 'move');
      else void separateLooseParts(editor);
    } else if (key === 'd' && e.shiftKey && edit) separateElementSelection(editor, 'copy');
    else if (key === 'delete' || key === 'backspace' || key === 'x') {
      if (edit) deleteElements(editor);
      else deleteSelected(editor);
    } else if (key === 'h' && e.altKey) showAll(editor);
    else if (key === 'h' && !edit) setVisibility(editor, editor.selection, false);
    else if (key === 'f') vp?.frame(edit && target ? [target] : editor.selectedObjects());
    else if (key === 'home') vp?.frame();
    else if (key === '5') vp?.setProjection(vp.projection === 'perspective' ? 'orthographic' : 'perspective');
    else if (key === 'escape') {
      if (edit) editor.exitEditMode();
      else editor.clearSelection();
    } else handled = false;
    if (handled) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
