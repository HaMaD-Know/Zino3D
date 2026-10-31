import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { FieldRow, NumberInput, Toggle } from '../../components/ui/Fields';
import { resetPreferences, updatePreferences, usePreferences } from '../../app/preferences';

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const prefs = usePreferences();
  const vp = prefs.viewport;
  const setVp = (patch: Partial<typeof vp>) => updatePreferences({ viewport: { ...vp, ...patch } });
  return (
    <Dialog
      title="Preferences"
      onClose={onClose}
      footer={
        <>
          <Button onClick={resetPreferences}>Reset to defaults</Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <span className="z-label">Rendering</span>
      <FieldRow label="Max pixel ratio">
        <select
          className="z-select"
          aria-label="Max pixel ratio"
          value={vp.maxPixelRatio}
          onChange={(e) => setVp({ maxPixelRatio: Number(e.target.value) })}
        >
          <option value={0.75}>0.75× (fastest)</option>
          <option value={1}>1×</option>
          <option value={1.5}>1.5×</option>
          <option value={2}>2× (sharp)</option>
          <option value={3}>3×</option>
        </select>
      </FieldRow>
      <Toggle
        label="Environment lighting (PBR reflections)"
        checked={vp.environment}
        onChange={(v) => setVp({ environment: v })}
      />
      <Toggle label="Shadows" checked={vp.shadows} onChange={(v) => setVp({ shadows: v })} />
      <Toggle label="Show grid and axes" checked={vp.showGrid} onChange={(v) => setVp({ showGrid: v })} />
      <Toggle
        label="Anti-aliasing (applies when a project is reopened)"
        checked={vp.antialias}
        onChange={(v) => setVp({ antialias: v })}
      />
      <div className="z-divider" />
      <span className="z-label">Export</span>
      <FieldRow label="Texture limit">
        <NumberInput
          label="Export texture size limit"
          value={prefs.exportMaxTextureSize}
          min={256}
          max={16384}
          step={256}
          precision={0}
          onCommit={(v) => updatePreferences({ exportMaxTextureSize: Math.round(v) })}
        />
      </FieldRow>
      <p className="z-hint">
        Zino3D works fully offline. It never uploads your models, sends analytics or calls AI services.
      </p>
    </Dialog>
  );
}
