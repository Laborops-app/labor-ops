/** Starter set for production companies: role groups, the roles in them, and shift templates that use those roles. */
export const STARTER_GROUPS: { name: string; roles: string[] }[] = [
  { name: 'Audio', roles: ['Audio'] },
  { name: 'Lighting', roles: ['Lighting'] },
  { name: 'Stage Hand', roles: ['Load In/Out Stage Hand Loader', 'Stage Hand Pusher'] },
  { name: 'Spot Op', roles: ['Spot Op'] },
  { name: 'Equipment Ops', roles: ['Fork Lift Op', 'Boom Op', 'Lull Op', 'Scissor Lift Op', 'High Lift Op'] },
];

type Item = { role: string; dayOffset: number; start: string; end: string; headcount: number };
const it = (role: string, start: string, end: string, headcount: number, dayOffset = 0): Item => ({ role, dayOffset, start, end, headcount });

const LOADER = 'Load In/Out Stage Hand Loader';
const PUSHER = 'Stage Hand Pusher';
const LOAD_IN = [it(LOADER, '07:00', '15:00', 6), it(PUSHER, '07:00', '15:00', 4), it('Fork Lift Op', '07:00', '15:00', 2), it('Lull Op', '07:00', '15:00', 1), it('Scissor Lift Op', '07:00', '15:00', 1)];
const LOAD_OUT = [it(LOADER, '22:00', '06:00', 6), it(PUSHER, '22:00', '06:00', 4), it('Fork Lift Op', '22:00', '06:00', 2), it('Lull Op', '22:00', '06:00', 1)];
const AUDIO = [it('Audio', '14:00', '23:00', 3)];
const LIGHTING = [it('Lighting', '14:00', '23:00', 3)];
const SPOT = [it('Spot Op', '17:00', '23:00', 4)];

export const STARTER_TEMPLATES: { name: string; items: Item[] }[] = [
  { name: 'Load-in', items: LOAD_IN },
  { name: 'Load-out', items: LOAD_OUT },
  { name: 'Audio crew', items: AUDIO },
  { name: 'Lighting crew', items: LIGHTING },
  { name: 'Spot ops', items: SPOT },
  { name: 'Equipment ops', items: [it('Fork Lift Op', '07:00', '15:00', 2), it('Boom Op', '07:00', '15:00', 1), it('Lull Op', '07:00', '15:00', 1), it('Scissor Lift Op', '07:00', '15:00', 1), it('High Lift Op', '07:00', '15:00', 1)] },
  { name: 'Full production day', items: [...LOAD_IN, ...AUDIO, ...LIGHTING, ...SPOT, ...LOAD_OUT] },
];
