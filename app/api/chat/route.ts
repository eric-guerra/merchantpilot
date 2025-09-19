import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { send } from '@/lib/agent';
import { merchantFromRequest } from '@/lib/auth';
import { pgStore, withSession } from '@/lib/pg';

export const runtime = 'nodejs';
const client = new Anthropic();

export async function POST(req: NextRequest) {
  const who = merchantFromRequest(req);
  if (!who) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { sessionId, message } = await req.json();
  if (typeof sessionId !== 'string' || typeof message !== 'string' || !message.trim() || message.length > 4000)
    return NextResponse.json({ error: 'sessionId and message required' }, { status: 400 });
  try {
    const result = await withSession(sessionId, who.merchantId, (s) =>
      send(s, message, { client, store: pgStore, actor: who.actor, today: new Date().toISOString().slice(0, 10) }));
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return NextResponse.json({ error: 'busy, try again shortly' }, { status: 429 });
    if (e instanceof Anthropic.APIError) return NextResponse.json({ error: 'assistant unavailable' }, { status: 502 });
    if (e instanceof Error && /pending/.test(e.message)) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
