// FR-273 D6 — one form for a git repo URL: host/owner/repo, lower case, no
// scheme, userinfo, port, fragment or trailing `.git`. A match is equality of
// two normalised forms; null never matches.

export function normaliseRepoUrl(raw: string): string | null {
  let s = raw.trim();
  if (s === '' || /\s/.test(s) || /^file:/i.test(s)) return null;
  s = s.replace(/^git\+/, '').replace(/[#?].*$/, '');
  if (s.startsWith('github:')) s = `github.com/${s.slice('github:'.length)}`;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
  if (scheme !== null) {
    s = s.slice(scheme[0].length).replace(/^[^@/]*@/, '');
    s = s.replace(/^([^/]+?):\d+(?=\/)/, '$1');
  } else {
    s = s.replace(/^[^@/]*@/, ''); // scp userinfo may hold `user:secret`
    const scp = /^([^/:]+):(?!\/)(.+)$/.exec(s);
    if (scp !== null) s = `${scp[1]}/${scp[2]}`;
  }
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  const parts = s.split('/').filter((p) => p !== '');
  if (parts.length === 2 && !parts[0].includes('.')) parts.unshift('github.com');
  if (parts.length < 3 || !parts[0].includes('.')) return null;
  return parts.join('/');
}

export function sameRepo(a: string, b: string): boolean {
  const na = normaliseRepoUrl(a);
  return na !== null && na === normaliseRepoUrl(b);
}
