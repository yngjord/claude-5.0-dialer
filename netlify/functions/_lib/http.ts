import type { Context } from '@netlify/functions';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Wraps a handler so thrown HttpErrors become JSON responses and anything else is a logged 500. `context` is
 * Netlify's (e.g. waitUntil, for work that finishes after the response is sent).
 */
export function handler(fn: (req: Request, context: Context) => Promise<Response>) {
  return async (req: Request, context: Context): Promise<Response> => {
    try {
      return await fn(req, context);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  };
}

export function env(name: string): string {
  // Trimmed: a value pasted into Netlify with a trailing space or newline otherwise fails auth (e.g. Twilio 70051).
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** A TwiML (XML) response for Twilio webhooks. */
export function twiml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' },
  });
}

/** Escapes text for use inside XML elements and attribute values. */
export function xml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid request body.');
  }
}
