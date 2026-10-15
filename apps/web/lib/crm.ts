/** "123 Main St, Denver, CO 80202" → "Denver, CO"; short addresses are shown as they are. */
export function cityOf(address: string | null | undefined) {
  if (!address) return null;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return address;
  const state = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, '').trim();
  return [parts[parts.length - 2], state].filter(Boolean).join(', ');
}

