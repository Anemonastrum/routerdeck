import crypto from 'node:crypto';

const secret = process.env.APP_SECRET || 'dev-only-change-me';
const adminPassword = process.env.ADMIN_PASSWORD || 'change-this-password';
const COOKIE = 'routerdeck_auth';

function sign(value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

export function makeToken() {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return false;
  const [body, signature] = token.split('.');
  if (!safeEqual(signature, sign(body))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Number(exp) > Date.now();
  } catch {
    return false;
  }
}

export function login(req, res) {
  if (!safeEqual(req.body?.password || '', adminPassword)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.cookie(COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
}

export function logout(_req, res) {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

export function requireAuth(req, res, next) {
  if (!verifyToken(req.cookies?.[COOKIE])) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

export function socketAuthorized(socket) {
  const cookie = socket.handshake.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return verifyToken(match?.[1]);
}
