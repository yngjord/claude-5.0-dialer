import { describe, expect, it } from 'vitest';
import { aboutLink, companyPrompt, pageText } from './companies';

describe('company pages', () => {
  const html = `<html><head><title>Acme &amp; Co | Rostering software</title>
    <meta name="description" content="Rostering for aged care providers">
    <script>var x = "<p>not this</p>";</script><style>.a{}</style></head>
    <body><nav><a href="/about-us">About</a><a href="https://twitter.com/acme">X</a></nav>
    <h1>Smarter rosters</h1><p>Acme helps 400&nbsp;aged care homes roster staff.</p><!-- hidden --></body></html>`;

  it('keeps the readable text and leaves out scripts, styles and markup', () => {
    const text = pageText(html);
    expect(text).toContain('Acme & Co | Rostering software');
    expect(text).toContain('Rostering for aged care providers');
    expect(text).toContain('Acme helps 400 aged care homes roster staff.');
    expect(text).not.toContain('not this');
    expect(text).not.toContain('hidden');
    expect(pageText(html, 20)).toHaveLength(20);
  });

  it('finds the About page on the same site only', () => {
    expect(aboutLink(html, 'https://www.acme.com.au/')).toBe('https://www.acme.com.au/about-us');
    expect(aboutLink('<a href="https://other.com/about">x</a>', 'https://acme.com.au/')).toBeNull();
    expect(aboutLink('<a href="/pricing">x</a>', 'https://acme.com.au/')).toBeNull();
  });

  it('shapes the request', () => {
    const p = companyPrompt({ name: 'Acme', domain: 'acme.com.au', linkedinUrl: null }, [{ source: 'website home page', text: 'Hello' }]);
    expect(p).toContain('Company: Acme');
    expect(p).toContain('Website: acme.com.au');
    expect(p).not.toContain('LinkedIn:');
    expect(p).toContain('<page source="website home page">\nHello\n</page>');
  });
});
