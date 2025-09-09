import { NextRequest, NextResponse } from 'next/server';

/**
 * The only place identity headers are set. Anything the browser sends as x-auth-* is discarded; the
 * values come from the admin app's signed session cookie: base64url(json).base64url(hmac-sha256).
 */
async function verify(cookie: string | undefined, secret: string): Promise<{ merchantId: string; user: string } | null> {
  if (!cookie) return null;
  const [body, sig] = cookie.split('.');
  if (!body || !sig) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  if (!(await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body)))) return null;
  const claims = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
  return { merchantId: String(claims.merchantId), user: String(claims.user) };
}

export async function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.delete('x-auth-merchant-id');
  headers.delete('x-auth-user');
  const secret = process.env.SESSION_SECRET;
  const who = secret ? await verify(req.cookies.get('admin_session')?.value, secret).catch(() => null) : null;
  if (who) {
    headers.set('x-auth-merchant-id', who.merchantId);
    headers.set('x-auth-user', who.user);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: '/api/:path*' };
