export type PdfFieldType = 'signature' | 'date' | 'name' | 'text' | 'checkbox';
export type PdfField = { id: string; type: PdfFieldType; page: number; x: number; y: number; w: number; h: number; label: string; required: boolean };
export type FormFieldType = 'checkbox' | 'yesno' | 'text' | 'number' | 'photo' | 'person' | 'signature';
export type FormField = { id: string; type: FormFieldType; label: string; required: boolean };
export type DocSettings = { required: boolean; who: 'lead' | 'everyone' | 'coordinator'; when: 'clock_in' | 'clock_out' | 'any'; useOn: 'all' | 'days' | 'roles'; dayContains: string; roles: string[]; alertOnNo: boolean; blockClockIn: boolean };
export type Template = { id: string; name: string; kind: 'pdf' | 'form'; purpose: 'onboarding' | 'shift'; file_name: string | null; page_count: number | null; fields: (PdfField | FormField)[]; settings: DocSettings; active: boolean; completed?: number };
export const DEFAULT_SETTINGS: DocSettings = { required: true, who: 'lead', when: 'any', useOn: 'all', dayContains: '', roles: [], alertOnNo: true, blockClockIn: false };
export const PDF_FIELD: Record<PdfFieldType, { label: string; w: number; h: number }> = {
  signature: { label: 'Signature', w: 0.3, h: 0.055 },
  date: { label: 'Date signed', w: 0.18, h: 0.028 },
  name: { label: 'Signer’s name', w: 0.3, h: 0.028 },
  text: { label: 'Text to fill in', w: 0.3, h: 0.028 },
  checkbox: { label: 'Checkbox', w: 0.025, h: 0.02 },
};
export const FORM_FIELD: Record<FormFieldType, string> = { checkbox: 'Checkbox', yesno: 'Yes / No', text: 'Text', number: 'Number', photo: 'Photo', person: 'Pick a person', signature: 'Signature' };
export const newId = () => Math.random().toString(36).slice(2, 10);
export const FORM_PRESETS: { name: string; settings: Partial<DocSettings>; fields: [FormFieldType, string, boolean?][] }[] = [
  { name: 'Load-in safety check', settings: { who: 'lead', when: 'clock_in', useOn: 'days', dayContains: 'load in' }, fields: [['checkbox', 'Everyone is wearing steel-toe boots and gloves'], ['checkbox', 'Hard hats on while rigging is overhead'], ['yesno', 'Is the dock and ramp clear and dry?'], ['person', 'Forklift operator (certificate checked)', false], ['photo', 'Photo of the truck load before unloading', false], ['text', 'Anything to report?', false], ['signature', 'Lead signature']] },
  { name: 'Incident report', settings: { who: 'everyone', when: 'any' }, fields: [['text', 'What happened?'], ['text', 'Where and when?'], ['person', 'Who was involved?', false], ['yesno', 'Was anyone hurt?'], ['yesno', 'Was the site lead told?'], ['photo', 'Photo', false], ['signature', 'Your signature']] },
  { name: 'Truck inspection', settings: { who: 'everyone', when: 'clock_in', useOn: 'roles', roles: ['Driver'] }, fields: [['yesno', 'Lights and signals working?'], ['yesno', 'Tires and brakes OK?'], ['yesno', 'Load secured?'], ['number', 'Odometer', false], ['photo', 'Photo of any damage', false], ['signature', 'Driver signature']] },
  { name: 'End-of-night walk-through', settings: { who: 'lead', when: 'clock_out' }, fields: [['checkbox', 'All gear is back in its cases'], ['checkbox', 'Work area is clean'], ['yesno', 'Anything damaged or missing?'], ['text', 'Notes for tomorrow', false], ['signature', 'Lead signature']] },
];
