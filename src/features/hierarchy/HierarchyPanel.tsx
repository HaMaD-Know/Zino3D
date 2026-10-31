import { type DragEvent, type MouseEvent as ReactMouseEvent, useMemo, useRef, useState } from 'react';
import {
  Box,
  Camera,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Focus,
  Folder,
  FolderPlus,
  Group as GroupIcon,
  Lock,
  LockOpen,
  Pencil,
  Search,
  Spline,
  Sun,
  Trash,
  Ungroup,
  X,
  Shapes,
  Hexagon,
} from 'lucide-react';
import type { Object3D } from 'three';
import { IconButton } from '../../components/ui/Button';
import { Menu, type MenuEntry } from '../../components/ui/Menu';
import { useEditorChannels, useEditorContext } from '../editor/EditorContext';
import { ROOT_ID, displayType, getId, isCollection } from '../../engine/scene/objectUtils';
import {
  collections,
  createCollection,
  deleteSelected,
  duplicateSelected,
  groupSelected,
  renameObject,
  reparent,
  setLocked,
  setVisibility,
  ungroupSelected,
} from '../../engine/editor/objectOperations';

interface Row {
  object: Object3D;
  id: string;
  depth: number;
  hasChildren: boolean;
}

function iconFor(o: Object3D) {
  const t = displayType(o);
  if (t === 'Collection') return { Icon: Folder, cls: 'tree__icon--collection' };
  if (t === 'Mesh' || t === 'Skinned Mesh') return { Icon: Hexagon, cls: 'tree__icon--mesh' };
  if (t === 'Light') return { Icon: Sun, cls: 'tree__icon--light' };
  if (t === 'Camera') return { Icon: Camera, cls: '' };
  if (t === 'Line' || t === 'Points') return { Icon: Spline, cls: '' };
  if (t === 'Bone') return { Icon: Shapes, cls: '' };
  return { Icon: Box, cls: '' };
}

export function HierarchyPanel() {
  const { editor, viewport } = useEditorContext();
  useEditorChannels(editor, ['scene', 'selection']);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const lastClicked = useRef<string | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const q = query.trim().toLowerCase();
    const matches = (o: Object3D): boolean => {
      if (!q) return true;
      if (o.name.toLowerCase().includes(q)) return true;
      return o.children.some(matches);
    };
    const walk = (o: Object3D, depth: number) => {
      for (const child of o.children) {
        if (!matches(child)) continue;
        const id = getId(child);
        out.push({ object: child, id, depth, hasChildren: child.children.length > 0 });
        if (child.children.length && (q || !collapsed.has(id))) walk(child, depth + 1);
      }
    };
    walk(editor.root, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editor.version('scene'), collapsed, query]);

  const selected = new Set(editor.selection);
  const activeId = editor.selection.at(-1);

  const onRowClick = (e: ReactMouseEvent, id: string) => {
    if (e.shiftKey && lastClicked.current) {
      const a = rows.findIndex((r) => r.id === lastClicked.current);
      const b = rows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        editor.select(
          rows.slice(from, to + 1).map((r) => r.id),
          'add',
        );
        return;
      }
    }
    editor.select([id], e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
    lastClicked.current = id;
  };

  const toggleCollapsed = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const menuEntries = (id: string): MenuEntry[] => {
    const o = editor.getObject(id);
    if (!o) return [];
    const ids = editor.selection.includes(id) ? editor.selection : [id];
    const cols = collections(editor).filter((c) => c !== o);
    return [
      { label: 'Rename', icon: Pencil, onSelect: () => setRenaming(id) },
      { label: 'Focus', icon: Focus, shortcut: 'F', onSelect: () => viewport?.frame([o]) },
      { label: 'Select children', onSelect: () => editor.select(editor.subtreeIds(o)) },
      { label: 'Select all', shortcut: 'A', onSelect: () => editor.selectAll() },
      { label: 'Invert selection', onSelect: () => editor.invertSelection() },
      { kind: 'separator' },
      { label: 'Duplicate', icon: Copy, shortcut: 'Ctrl+D', onSelect: () => duplicateSelected(editor) },
      { label: 'Group', icon: GroupIcon, shortcut: 'Ctrl+G', onSelect: () => groupSelected(editor) },
      {
        label: 'Ungroup',
        icon: Ungroup,
        disabled: o.children.length === 0,
        onSelect: () => ungroupSelected(editor),
      },
      {
        label: o.visible ? 'Hide' : 'Show',
        icon: o.visible ? EyeOff : Eye,
        onSelect: () => setVisibility(editor, ids, !o.visible),
      },
      {
        label: editor.isLocked(o) ? 'Unlock' : 'Lock',
        icon: editor.isLocked(o) ? LockOpen : Lock,
        onSelect: () => setLocked(editor, ids, !o.userData.zinoLocked),
      },
      { kind: 'separator' },
      { kind: 'label', label: 'Move to' },
      { label: 'Scene (top level)', onSelect: () => reparent(editor, ids, ROOT_ID) },
      ...cols.map((c) => ({
        label: c.name || 'Collection',
        icon: Folder,
        onSelect: () => reparent(editor, ids, getId(c)),
      })),
      { kind: 'separator' },
      { label: 'Delete', icon: Trash, danger: true, shortcut: 'Del', onSelect: () => deleteSelected(editor) },
    ];
  };

  const onDragStart = (e: DragEvent, id: string) => {
    if (!selected.has(id)) editor.select([id]);
    e.dataTransfer.setData(
      'application/x-zino-ids',
      JSON.stringify(editor.selection.includes(id) ? editor.selection : [id]),
    );
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    setDropTarget(null);
    const raw = e.dataTransfer.getData('application/x-zino-ids');
    if (!raw) return;
    reparent(editor, JSON.parse(raw) as string[], targetId);
  };

  return (
    <>
      <div className="sidepanel__head">
        <h2>Scene</h2>
        <IconButton
          icon={FolderPlus}
          label="New collection"
          size="sm"
          onClick={() => setRenaming(createCollection(editor))}
        />
        <IconButton
          icon={GroupIcon}
          label="Group selected"
          size="sm"
          disabled={!editor.selection.length}
          onClick={() => groupSelected(editor)}
        />
      </div>
      <div className="tree-search">
        <Search size={14} />
        <input
          className="z-input"
          placeholder="Search objects"
          aria-label="Search objects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <IconButton icon={X} label="Clear search" size="sm" onClick={() => setQuery('')} />}
      </div>
      <div
        className="sidepanel__scroll"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(e, ROOT_ID)}
        onClick={(e) => {
          if (e.target === e.currentTarget) editor.clearSelection();
        }}
      >
        {rows.length === 0 ? (
          <div className="tree-empty">
            {query ? 'No objects match your search.' : 'The scene is empty. Import a model to begin.'}
          </div>
        ) : (
          <ul className="tree" role="tree" aria-label="Scene hierarchy" aria-multiselectable>
            {rows.map((r) => {
              const { Icon, cls } = iconFor(r.object);
              const locked = r.object.userData.zinoLocked === true;
              const hidden = !r.object.visible;
              return (
                <li
                  key={r.id}
                  role="treeitem"
                  aria-selected={selected.has(r.id)}
                  aria-expanded={r.hasChildren ? !collapsed.has(r.id) : undefined}
                  aria-level={r.depth + 1}
                  className={`tree__row ${selected.has(r.id) ? 'tree__row--selected' : ''} ${r.id === activeId ? 'tree__row--active' : ''} ${hidden ? 'tree__row--hidden' : ''} ${dropTarget === r.id ? 'tree__row--drop' : ''}`}
                  style={{ paddingLeft: 4 + r.depth * 14 }}
                  draggable={renaming !== r.id}
                  onDragStart={(e) => onDragStart(e, r.id)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDropTarget(r.id);
                  }}
                  onDragLeave={() => setDropTarget((d) => (d === r.id ? null : d))}
                  onDrop={(e) => {
                    e.stopPropagation();
                    onDrop(e, r.id);
                  }}
                  onClick={(e) => onRowClick(e, r.id)}
                  onDoubleClick={() => setRenaming(r.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!selected.has(r.id)) editor.select([r.id]);
                    setMenu({ x: e.clientX, y: e.clientY, id: r.id });
                  }}
                  onPointerDown={(e) => {
                    if (e.pointerType !== 'touch') return;
                    const { clientX, clientY } = e;
                    longPress.current = setTimeout(() => {
                      if (!editor.selection.includes(r.id)) editor.select([r.id]);
                      setMenu({ x: clientX, y: clientY, id: r.id });
                    }, 550);
                  }}
                  onPointerUp={() => longPress.current && clearTimeout(longPress.current)}
                  onPointerMove={() => longPress.current && clearTimeout(longPress.current)}
                >
                  {r.hasChildren ? (
                    <button
                      type="button"
                      className="tree__twisty"
                      aria-label={collapsed.has(r.id) ? 'Expand' : 'Collapse'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(r.id);
                      }}
                    >
                      {collapsed.has(r.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                  ) : (
                    <span style={{ width: 18, flex: 'none' }} />
                  )}
                  <Icon size={14} className={`tree__icon ${cls}`} aria-hidden />
                  {renaming === r.id ? (
                    <input
                      className="z-input tree__rename"
                      aria-label="Object name"
                      autoFocus
                      defaultValue={r.object.name}
                      onClick={(e) => e.stopPropagation()}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={(e) => {
                        renameObject(editor, r.id, e.target.value);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setRenaming(null);
                        e.stopPropagation();
                      }}
                    />
                  ) : (
                    <span
                      className="tree__name"
                      title={`${r.object.name || '(unnamed)'} · ${displayType(r.object)}`}
                    >
                      {r.object.name || (
                        <i style={{ color: 'var(--z-text-3)' }}>
                          unnamed {displayType(r.object).toLowerCase()}
                        </i>
                      )}
                      {isCollection(r.object) && (
                        <span className="z-hint"> · {r.object.children.length}</span>
                      )}
                    </span>
                  )}
                  <IconButton
                    icon={locked ? Lock : LockOpen}
                    label={locked ? 'Unlock' : 'Lock'}
                    size="sm"
                    data-on={locked}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLocked(editor, [r.id], !locked);
                    }}
                  />
                  <IconButton
                    icon={hidden ? EyeOff : Eye}
                    label={hidden ? 'Show' : 'Hide'}
                    size="sm"
                    data-on={hidden}
                    onClick={(e) => {
                      e.stopPropagation();
                      setVisibility(editor, [r.id], hidden);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {menu && (
        <Menu
          anchor={{ x: menu.x, y: menu.y }}
          entries={menuEntries(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
