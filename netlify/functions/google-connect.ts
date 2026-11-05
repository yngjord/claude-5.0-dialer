import type { Config } from '@netlify/functions';
import { authUrl, CONTACT, hostPage, sign, verify } from './_lib/google';
import { handler } from './_lib/http';

/**
 * GET /api/google/connect?t=…: the link an admin sends a client's host. Sends them to Google's consent screen; the
 * signed state brings the client id (and the link, for a retry) back to /api/google/callback.
 */
export default handler(async (req) => {
  const t = new URL(req.url).searchParams.get('t');
  const link = verify<{ c: string }>(t);
  if (!link) return hostPage('This link has expired', `Please ask ${CONTACT} for a new one.`, false);
  return Response.redirect(authUrl(new URL(req.url).origin, sign({ c: link.c, t }, 30 * 60)), 302);
});

export const config: Config = { path: '/api/google/connect', method: 'GET' };
