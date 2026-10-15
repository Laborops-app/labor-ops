/** Stages of the event pipeline, in board order, with the colour of each column. */
export type PipelineStatus = 'pending' | 'quote' | 'confirmed' | 'in_progress' | 'completed' | 'canceled';
export type Priority = 'low' | 'medium' | 'high';
export const STATUS_ORDER: PipelineStatus[] = ['pending', 'quote', 'confirmed', 'in_progress', 'completed', 'canceled'];
export const STATUS: Record<PipelineStatus, { label: string; color: string; empty: string }> = {
  pending: { label: 'Pending', color: '#5030e5', empty: 'New inquiries land here.' },
  quote: { label: 'Quote', color: '#ffa500', empty: 'Events waiting on a quote answer.' },
  confirmed: { label: 'Confirmed', color: '#3b82f6', empty: 'Booked events being staffed.' },
  in_progress: { label: 'In progress', color: '#2dc8a8', empty: 'Events happening now.' },
  completed: { label: 'Completed', color: '#8bc48a', empty: 'Finished events.' },
  canceled: { label: 'Canceled', color: '#d8727d', empty: 'Nothing canceled.' },
};
export const PRIORITY: Record<Priority, { label: string; tone: string }> = {
  low: { label: 'Low', tone: 'orange' },
  medium: { label: 'Medium', tone: 'blue' },
  high: { label: 'High', tone: 'red' },
};
