import { useState } from 'react';
import { Color, type Material, type Mesh, type MeshStandardMaterial, type Texture } from 'three';
import { Copy, ImagePlus, Plus, Trash } from 'lucide-react';
import { Section } from '../../components/ui/Section';
import { Button, IconButton } from '../../components/ui/Button';
import { ColorField, FieldRow, SliderField, TextField, Toggle } from '../../components/ui/Fields';
import { useEditorChannels, useEditorContext } from '../editor/EditorContext';
import {
  TEXTURE_SLOTS,
  assignMaterialToSelection,
  convertToStandard,
  createMaterialForSelection,
  makeMaterialUnique,
  materialUsage,
  renameMaterial,
  setDoubleSided,
  setMaterialValue,
  setTexture,
  textureFromFile,
  usersOf,
} from '../../engine/editor/materialOperations';
import { getId, objectMaterials } from '../../engine/scene/objectUtils';
import { pickFiles } from '../../platform/fileIO';
import { describeError } from '../../utils/errors';
import { texturePreview } from './texturePreview';

function hex(c: Color): string {
  return `#${c.getHexString()}`;
}

function alphaMode(m: Material): 'opaque' | 'blend' | 'mask' {
  if (m.transparent) return 'blend';
  if (m.alphaTest > 0) return 'mask';
  return 'opaque';
}

function TextureRow({
  material,
  slot,
  label,
  onReplace,
  locked,
}: {
  material: Material;
  slot: string;
  label: string;
  onReplace: () => void;
  locked: boolean;
}) {
  const { editor } = useEditorContext();
  const tex = (material as unknown as Record<string, Texture | null>)[slot] ?? null;
  const preview = tex ? texturePreview(tex) : null;
  const img = tex?.image as { width?: number; height?: number } | undefined;
  const missing = !!tex && !img?.width;
  return (
    <div className="tex-row">
      {preview ? (
        <img className="tex-thumb" src={preview} alt="" />
      ) : (
        <span className="tex-thumb" aria-hidden />
      )}
      <div className="tex-row__meta">
        <b>{label}</b>
        {tex ? (
          missing ? (
            <span style={{ color: 'var(--z-warning)' }}>Missing image</span>
          ) : (
            `${tex.name || 'texture'} · ${img?.width}×${img?.height}`
          )
        ) : (
          'None'
        )}
      </div>
      <div style={{ display: 'flex' }}>
        <IconButton
          icon={ImagePlus}
          label={`${tex ? 'Replace' : 'Assign'} ${label} texture`}
          size="sm"
          disabled={locked}
          onClick={onReplace}
        />
        {tex && (
          <IconButton
            icon={Trash}
            label={`Remove ${label} texture`}
            size="sm"
            disabled={locked}
            onClick={() => setTexture(editor, material, slot, null)}
          />
        )}
      </div>
    </div>
  );
}

export function MaterialSection({ mesh }: { mesh: Mesh }) {
  const { editor } = useEditorContext();
  useEditorChannels(editor, ['material', 'scene']);
  const [slot, setSlot] = useState(0);
  const mats = objectMaterials(mesh);
  const index = Math.min(slot, mats.length - 1);
  const material = mats[index];
  if (!material) return null;
  const locked = editor.isLocked(mesh);
  const shared = usersOf(editor, material);
  const std = material as MeshStandardMaterial;
  const isStandard = std.isMeshStandardMaterial === true;
  const all = materialUsage(editor);

  const replaceTexture = async (key: string) => {
    const [file] = await pickFiles({ accept: 'image/png,image/jpeg,image/webp' });
    if (!file) return;
    try {
      const existing = (material as unknown as Record<string, Texture | null>)[key];
      const t = await textureFromFile(file, existing ? existing.flipY : false);
      if (existing) {
        t.wrapS = existing.wrapS;
        t.wrapT = existing.wrapT;
        t.repeat.copy(existing.repeat);
        t.offset.copy(existing.offset);
        t.channel = existing.channel;
      }
      setTexture(editor, material, key, t);
    } catch (error) {
      editor.message('error', `Could not load texture: ${describeError(error)}`);
    }
  };

  return (
    <Section
      title="Material"
      actions={
        <IconButton
          icon={Plus}
          label="New material for selection"
          size="sm"
          disabled={locked}
          onClick={() => createMaterialForSelection(editor)}
        />
      }
    >
      {mats.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {mats.map((m, i) => (
            <button
              key={i}
              type="button"
              className="mat-slot"
              aria-pressed={i === index}
              onClick={() => setSlot(i)}
            >
              <span
                className="mat-swatch"
                style={{
                  background: (m as MeshStandardMaterial).color
                    ? hex((m as MeshStandardMaterial).color)
                    : '#888',
                }}
              />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {i + 1}. {m.name || 'Unnamed material'}
              </span>
            </button>
          ))}
        </div>
      )}
      <FieldRow label="Name">
        <TextField
          label="Material name"
          value={material.name}
          disabled={locked}
          onCommit={(v) => renameMaterial(editor, material, v)}
        />
      </FieldRow>
      <FieldRow label="Type">
        <span className="z-badge">{material.type.replace('Material', '')}</span>
      </FieldRow>
      {shared > 1 && (
        <div className="callout callout--warn" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>Shared by {shared} objects/slots — edits affect all of them.</span>
          <Button
            size="sm"
            icon={Copy}
            disabled={locked}
            onClick={() => makeMaterialUnique(editor, getId(mesh), index)}
          >
            Make unique
          </Button>
        </div>
      )}
      {!isStandard && (
        <div className="callout" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>
            Legacy material. Convert to PBR for metallic/roughness editing and accurate GLB export.
          </span>
          <Button size="sm" disabled={locked} onClick={() => convertToStandard(editor, getId(mesh), index)}>
            Convert
          </Button>
        </div>
      )}
      {'color' in material && (material as MeshStandardMaterial).color instanceof Color && (
        <ColorField
          label="Base color"
          value={hex(std.color)}
          disabled={locked}
          onChange={(v) => setMaterialValue(editor, material, 'color', new Color(v).getHex(), 'Base color')}
        />
      )}
      {isStandard && (
        <>
          <SliderField
            label="Metallic"
            value={std.metalness}
            disabled={locked}
            onChange={(v) => setMaterialValue(editor, material, 'metalness', v, 'Metallic')}
          />
          <SliderField
            label="Roughness"
            value={std.roughness}
            disabled={locked}
            onChange={(v) => setMaterialValue(editor, material, 'roughness', v, 'Roughness')}
          />
        </>
      )}
      <SliderField
        label="Opacity"
        value={material.opacity}
        disabled={locked}
        onChange={(v) => setMaterialValue(editor, material, 'opacity', v, 'Opacity')}
      />
      <FieldRow label="Alpha mode">
        <select
          className="z-select"
          aria-label="Alpha mode"
          disabled={locked}
          value={alphaMode(material)}
          onChange={(e) => {
            const mode = e.target.value;
            editor.batch(() => {
              setMaterialValue(editor, material, 'transparent', mode === 'blend', 'Alpha mode');
              setMaterialValue(
                editor,
                material,
                'alphaTest',
                mode === 'mask' ? Math.max(material.alphaTest, 0.5) : 0,
                'Alpha cutoff',
              );
              if (mode !== 'blend') setMaterialValue(editor, material, 'depthWrite', true, 'Depth write');
            });
          }}
        >
          <option value="opaque">Opaque</option>
          <option value="blend">Blend (transparent)</option>
          <option value="mask">Mask (cutout)</option>
        </select>
      </FieldRow>
      {alphaMode(material) === 'mask' && (
        <SliderField
          label="Alpha cutoff"
          value={material.alphaTest}
          disabled={locked}
          onChange={(v) => setMaterialValue(editor, material, 'alphaTest', v, 'Alpha cutoff')}
        />
      )}
      <Toggle
        label="Double-sided"
        checked={material.side === 2}
        disabled={locked}
        onChange={(v) => setDoubleSided(editor, material, v)}
      />
      {'emissive' in material && std.emissive instanceof Color && (
        <>
          <ColorField
            label="Emissive"
            value={hex(std.emissive)}
            disabled={locked}
            onChange={(v) =>
              setMaterialValue(editor, material, 'emissive', new Color(v).getHex(), 'Emissive color')
            }
          />
          <SliderField
            label="Emissive power"
            value={std.emissiveIntensity}
            min={0}
            max={10}
            step={0.1}
            disabled={locked}
            onChange={(v) => setMaterialValue(editor, material, 'emissiveIntensity', v, 'Emissive intensity')}
          />
        </>
      )}
      <div className="z-divider" />
      <span className="z-label">
        Textures {mesh.geometry.getAttribute('uv') ? '' : '— this mesh has no UV coordinates'}
      </span>
      {TEXTURE_SLOTS.filter((s) => s.key in material).map((s) => (
        <TextureRow
          key={s.key}
          material={material}
          slot={s.key}
          label={s.label}
          locked={locked}
          onReplace={() => void replaceTexture(s.key)}
        />
      ))}
      <div className="z-divider" />
      <FieldRow label="Assign">
        <select
          className="z-select"
          aria-label="Assign an existing material to the selection"
          disabled={locked}
          value=""
          onChange={(e) => {
            const target = all[Number(e.target.value)];
            if (target) assignMaterialToSelection(editor, target.material);
          }}
        >
          <option value="">Existing material…</option>
          {all.map((u, i) => (
            <option key={u.material.uuid} value={i}>
              {u.material.name || 'Unnamed'} ({u.users.length} use{u.users.length === 1 ? '' : 's'})
            </option>
          ))}
        </select>
      </FieldRow>
    </Section>
  );
}
