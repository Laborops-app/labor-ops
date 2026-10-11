'use client';

export const roleKey = (role: string) => role.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();

/** Five clickable stars. Clicking the current rating clears it. Read-only when no onChange is given. */
export function Stars({ value, onChange, label }: { value?: number; onChange?: (n: number | null) => void; label: string }) {
  return (
    <span className="stars" role={onChange ? 'group' : 'img'} aria-label={`${label}: ${value ? value + ' of 5 stars' : 'not rated'}`}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button key={n} type="button" className={n <= (value ?? 0) ? 'star on' : 'star'} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => onChange(value === n ? null : n)}>
            ★
          </button>
        ) : (
          <span key={n} className={n <= (value ?? 0) ? 'star on' : 'star'} aria-hidden>★</span>
        ),
      )}
    </span>
  );
}
