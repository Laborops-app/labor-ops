import { planLabel } from './Console';

/** Plain-language lines for the platform activity log. */
export const FEED: Record<string, string> = {
  signup: 'New company signed up', 'company.suspend': 'Company suspended', 'company.unsuspend': 'Suspension lifted', 'company.plan': 'Plan changed',
  'company.rename': 'Company renamed', 'company.notes': 'Notes updated', 'admin.invite': 'Platform admin invited', 'admin.link': 'New sign-in link made',
  'admin.remove': 'Platform admin removed', 'account.setup': 'Platform admin set up their account', 'password.reset': 'Password reset', 'password.change': 'Password changed',
  'storage.save': 'Storage settings changed', 'backup.manual': 'Manual backup started', login: 'Signed in to the console',
};
export const feedText = (f: { action: string; detail: any }) => {
  const base = FEED[f.action] ?? f.action;
  const d = f.detail ?? {};
  if (f.action === 'company.plan') return `${base}: ${planLabel(d.from)} → ${planLabel(d.to)}`;
  if (f.action === 'company.rename') return `${base}: ${d.from} → ${d.to}`;
  if (f.action === 'company.suspend' && d.reason) return `${base}: ${d.reason}`;
  if (d.email && f.action.startsWith('admin.')) return `${base}: ${d.email}`;
  return base;
};
