import { Dialog } from '../../components/ui/Dialog';
import { SHORTCUTS } from '../editor/shortcuts';

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard & touch controls" onClose={onClose}>
      <dl className="z-stats">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={{ fontFamily: 'var(--z-mono)' }}>{k}</dt>
            <dd style={{ textAlign: 'left' }}>{v}</dd>
          </div>
        ))}
      </dl>
      <span className="z-label">Touch</span>
      <ul className="z-hint" style={{ margin: 0, paddingLeft: 18 }}>
        <li>One finger: orbit · Two fingers: pan and pinch-zoom</li>
        <li>Tap: select · Enable “Multi-select” in the toolbar to add to the selection</li>
        <li>Long-press a row in the scene list for more actions</li>
        <li>Mouse: left-drag orbit, right-drag pan, wheel zoom</li>
      </ul>
    </Dialog>
  );
}
