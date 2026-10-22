import type { Config } from '@netlify/functions';
import { requireDialerUser } from './_lib/auth';
import { handler, json } from './_lib/http';

export default handler(async (req) => json(await requireDialerUser(req)));

export const config: Config = { path: '/api/me', method: 'GET' };
