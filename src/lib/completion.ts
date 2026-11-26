/** How far through its contacts a campaign is: dialled (and wrapped up), skipped by a rep, and still to call. */
export function completion(stats: { contacts_total?: number; contacts_remaining?: number; contacts_skipped?: number } | null | undefined) {
  const total = stats?.contacts_total ?? 0;
  const remaining = stats?.contacts_remaining ?? 0;
  const skipped = stats?.contacts_skipped ?? 0;
  return { total, remaining, skipped, dialled: Math.max(0, total - remaining - skipped), complete: total > 0 && remaining === 0 };
}
