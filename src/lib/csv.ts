const escape = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(headers: string[], rows: (string | null | undefined)[][]): string {
  return [headers, ...rows].map((row) => row.map((v) => escape(v ?? '')).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, csv: string) {
  // BOM so Excel opens UTF-8 correctly
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
