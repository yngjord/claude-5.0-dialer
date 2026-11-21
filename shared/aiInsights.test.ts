import { describe, expect, it } from 'vitest';
import { bulletItems, bulletText, callForReview, contextBlock } from './aiInsights';

describe('AI call insights', () => {
  const call = {
    agentName: 'Kai Minors',
    prospectName: 'Julie Enticott',
    title: 'Director',
    company: 'Acme Recruitment',
    campaignName: 'CC019',
    startedAt: '2026-11-19T23:30:00Z',
    durationS: 134,
    disposition: 'Interested - Appointment Set',
    notes: ' Monday 30th 11am ',
    transcriptJson: [
      { speaker: 'Julie Enticott', text: 'Julie speaking.', start: 0 },
      { speaker: 'Kai Minors', text: ' Hi Julie, it’s Kai. ', start: 2.4 },
      { speaker: 'Julie Enticott', text: 'Sure, Monday works.', start: 71 },
    ],
    transcript: null,
  };

  it('shows the call with who the rep is, the outcome and a timestamped transcript', () => {
    const text = callForReview(call);
    expect(text).toContain('Rep: Kai Minors');
    expect(text).toContain('Prospect: Julie Enticott, Director, Acme Recruitment');
    expect(text).toContain('Date: 20 Nov 2026'); // Sydney date
    expect(text).toContain('Length: 2:14');
    expect(text).toContain('Outcome the rep recorded: Interested - Appointment Set');
    expect(text).toContain("Rep's notes: Monday 30th 11am");
    expect(text).toContain('"Kai Minors" is the rep');
    expect(text).toContain('[0:02] Kai Minors: Hi Julie, it’s Kai.\n[1:11] Julie Enticott: Sure, Monday works.');
  });

  it('falls back to the plain transcript and leaves out what it doesn’t know', () => {
    const text = callForReview({ ...call, transcriptJson: null, transcript: 'Kai: Hi\nJulie: Hello', notes: '', title: null, durationS: null, campaignName: null });
    expect(text).toContain('<transcript>\nKai: Hi\nJulie: Hello\n</transcript>');
    expect(text).not.toContain("Rep's notes");
    expect(text).not.toContain('Length');
    expect(text).toContain('Prospect: Julie Enticott, Acme Recruitment');
  });

  it('stores points one per line and reads them back', () => {
    const stored = bulletText([' Asked for the meeting ', '', '- Used the 30% stat']);
    expect(stored).toBe('- Asked for the meeting\n- Used the 30% stat');
    expect(bulletItems(stored)).toEqual(['Asked for the meeting', 'Used the 30% stat']);
    expect(bulletText([])).toBe('');
    expect(bulletItems(null)).toEqual([]);
  });

  it('wraps the client context', () => {
    expect(contextBlock('Kintell "AU"', ' We make videos. ')).toBe('<client_context client="Kintell \'AU\'">\nWe make videos.\n</client_context>');
  });
});
