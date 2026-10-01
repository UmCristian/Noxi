import { createHmac, timingSafeEqual } from 'node:crypto';
const lifetime = 7 * 24 * 60 * 60;
function sign(payload, key) {
  return createHmac('sha256', key).update(payload).digest('hex');
}
function equal(a, b) {
  return (
    typeof a === 'string' &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function authenticated(cookie, key) {
  const raw = (cookie || '')
    .split(';')
    .find((part) => part.trim().startsWith('noxi_auth='))
    ?.trim()
    .slice(10);
  if (!raw) return false;
  const [expiry, signature] = raw.split('.');
  return Number(expiry) > Date.now() && equal(signature, sign(expiry, key));
}
function setCookie(res, value, maxAge) {
  res.setHeader(
    'Set-Cookie',
    `noxi_auth=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.VERCEL ? '; Secure' : ''}`,
  );
}
export function requirePasskey(req, res, next) {
  const key = process.env.PASS_KEY;
  const publicPaths = [
    '/login',
    '/login.js',
    '/login.css',
    '/styles.css',
    '/tokens.css',
    '/mark.svg',
  ];
  res.setHeader('Cache-Control', 'no-store');
  if (req.path === '/logout' && req.method === 'POST') {
    setCookie(res, '', 0);
    return res.redirect(303, '/login');
  }
  if (req.path === '/login' && req.method === 'POST') {
    if (!key) return res.redirect(303, '/login?setup=1');
    if (!equal(req.body?.key, key)) return res.redirect(303, '/login?error=1');
    const expiry = String(Date.now() + lifetime * 1000);
    setCookie(res, `${expiry}.${sign(expiry, key)}`, lifetime);
    return res.redirect(303, '/');
  }
  if (req.method === 'GET' && publicPaths.includes(req.path)) return next();
  if (!key) {
    if (req.path.startsWith('/api/'))
      return res.status(503).json({ error: 'Set PASS_KEY on the server to enable access.' });
    return res.redirect('/login?setup=1');
  }
  if (authenticated(req.headers.cookie, key)) return next();
  if (req.path.startsWith('/api/'))
    return res.status(401).json({ error: 'Your session has expired. Sign in again at /login.' });
  return res.redirect('/login');
}
