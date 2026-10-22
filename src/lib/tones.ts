import type { Tone } from '../components/ui/Badge';

// Mirrors the option colours in Airtable (same as the portal's Cold Call Logs).
export const DISPOSITION_TONES: Record<string, Tone> = {
  'Interested - Appointment Set': 'greenSolid',
  'Interested - Needs Follow-Up': 'green',
  'Not Interested': 'orange',
  'Left Voicemail': 'sky',
  'No Answer': 'grey',
  'Unqualified Lead': 'amber',
  'Wrong Number': 'amber',
  'Do Not Call': 'redSolid',
  'Disconnected Number': 'grey',
};

export const PICKUP_TONES: Record<string, Tone> = {
  'Human Pickup': 'green',
  'Machine Pickup': 'sky',
  'Unclassified Pickup': 'purple',
  Unanswered: 'grey',
  Busy: 'grey',
  Failed: 'red',
};

export const CONTACT_STATUS_LABELS: Record<string, { label: string; tone: Tone }> = {
  new: { label: 'To call', tone: 'blue' },
  callback: { label: 'Callback', tone: 'amber' },
  done: { label: 'Done', tone: 'grey' },
  do_not_call: { label: 'Do not call', tone: 'redSolid' },
  bad_number: { label: 'Bad number', tone: 'dark' },
};
