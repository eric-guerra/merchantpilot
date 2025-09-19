import type { NextRequest } from 'next/server';

/**
 * Identity comes from the admin app's session (set by its auth middleware after SSO). The browser
 * never chooses the merchant: a session id from another merchant simply doesn't load (see withSession).
 */
export function merchantFromRequest(req: NextRequest): { merchantId: string; actor: string } | null {
  const merchantId = req.headers.get('x-auth-merchant-id');
  const user = req.headers.get('x-auth-user');
  if (merchantId && user) return { merchantId, actor: `merchant:${user}` };
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_MERCHANT_ID) return { merchantId: process.env.DEV_MERCHANT_ID, actor: 'merchant:dev' };
  return null;
}
