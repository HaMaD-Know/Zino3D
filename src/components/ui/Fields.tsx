import { type ReactNode, useEffect, useId, useState } from 'react';

function format(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '';
  const fixed = value.toFixed(precision);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

export interface NumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  precision?: number;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  axis?: 'x' | 'y' | 'z';
  label: string;
}

/** Numeric text input that commits on Enter/blur and supports arrow-key stepping. Accepts simple math. */
export function NumberInput({
  value,
  onCommit,
  precision = 4,
  step = 0.1,
  min,
  max,
  disabled,
  axis,
  label,
}: NumberInputProps) {
  const [text, setText] = useState(format(value, precision));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(format(value, precision));
  }, [value, precision, focused]);

  const commit = (raw: string) => {
    const parsed = evaluate(raw);
    if (parsed === null) {
      setText(format(value, precision));
      return;
    }
    let v = parsed;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (v !== value) onCommit(v);
    setText(format(v, precision));
  };

  const input = (
    <input
      className="z-input"
      inputMode="decimal"
      aria-label={label}
      value={text}
      disabled={disabled}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onBlur={(e) => {
        setFocused(false);
        commit(e.currentTarget.value);
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit(e.currentTarget.value);
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setText(format(value, precision));
          e.currentTarget.blur();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
          const next =
            (evaluate(e.currentTarget.value) ?? value) + (e.key === 'ArrowUp' ? step : -step) * mult;
          commit(String(next));
        }
      }}
    />
  );
  if (!axis) return input;
  return (
    <div className={`z-num z-num--${axis}`}>
      <span aria-hidden>{axis.toUpperCase()}</span>
      {input}
    </div>
  );
}

/** Evaluates a number or a tiny arithmetic expression like "2*3" or "1.5+0.25" (no eval). */
export function evaluate(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '.');
  if (s === '') return null;
  if (!/^[\d+\-*/().\se]+$/i.test(s)) return null;
  const tokens = s.match(/\d*\.?\d+(?:e[+-]?\d+)?|[+\-*/()]/gi);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') v = tokens[i++] === '+' ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') v = tokens[i++] === '*' ? v * factor() : v / factor();
    return v;
  };
  const factor = (): number => {
    const t = tokens[i++];
    if (t === '-') return -factor();
    if (t === '+') return factor();
    if (t === '(') {
      const v = expr();
      i++;
      return v;
    }
    return Number(t);
  };
  try {
    const v = expr();
    return i === tokens.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function Vec3Field({
  label,
  value,
  onCommit,
  precision,
  step,
  disabled,
}: {
  label: string;
  value: [number, number, number];
  onCommit: (v: [number, number, number]) => void;
  precision?: number;
  step?: number;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="z-field-row">
      <label id={id}>{label}</label>
      <div className="z-vec3" role="group" aria-labelledby={id}>
        {(['x', 'y', 'z'] as const).map((axis, i) => (
          <NumberInput
            key={axis}
            axis={axis}
            label={`${label} ${axis.toUpperCase()}`}
            value={value[i]}
            precision={precision}
            step={step}
            disabled={disabled}
            onCommit={(v) => {
              const next = [...value] as [number, number, number];
              next[i] = v;
              onCommit(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="z-field-row">
      <label>{label}</label>
      <div>{children}</div>
    </div>
  );
}

export function SliderField({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <FieldRow label={label}>
      <div className="z-slider">
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <NumberInput
          label={`${label} value`}
          value={value}
          min={min}
          max={max}
          step={step}
          precision={3}
          disabled={disabled}
          onCommit={onChange}
        />
      </div>
    </FieldRow>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}) {
  return (
    <FieldRow label={label}>
      <div className="z-color">
        <input
          type="color"
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <code className="z-hint">{value.toUpperCase()}</code>
      </div>
    </FieldRow>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="z-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function TextField({
  value,
  onCommit,
  label,
  disabled,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="z-input"
      aria-label={label}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
