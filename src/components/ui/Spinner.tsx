export function Spinner({ label }: { label?: string }) {
  return <span className="z-spinner" role="progressbar" aria-label={label ?? 'Working'} />;
}
