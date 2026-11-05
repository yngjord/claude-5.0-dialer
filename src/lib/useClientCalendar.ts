import { useEffect, useState } from 'react';
import type { ClientCalendar } from '../../shared/calendar';
import { supabase } from './supabase';

/** A client's Google Calendar settings and connection (null if never set up, or while loading). */
export function useClientCalendar(airtableClientId: string | null | undefined): ClientCalendar | null {
  const [calendar, setCalendar] = useState<ClientCalendar | null>(null);
  useEffect(() => {
    setCalendar(null);
    if (!airtableClientId) return;
    let live = true;
    supabase
      .from('dialer_client_calendars')
      .select('*')
      .eq('airtable_client_id', airtableClientId)
      .maybeSingle()
      .then(({ data }) => live && setCalendar((data as ClientCalendar | null) ?? null));
    return () => {
      live = false;
    };
  }, [airtableClientId]);
  return calendar;
}
