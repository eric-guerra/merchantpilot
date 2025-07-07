import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { decide } from '@/lib/agent';
import { merchantFromRequest } from '@/lib/auth';
import { pgStore, withSession } from '@/lib/pg';

export const runtime = 'nodejs';
const client = new Anthropic();

export async function POST(req: NextRequest) {
  const who = merchantFromRequest(req);
  if (!who) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { sessionId, approved, note } = await req.json();
  if (typeof sessionId !== 'string' || typeof approved !== 'boolean') return NextResponse.json({ error: 'bad request' }, { status: 400 });
  try {
    const result = await withSession(sessionId, who.merchantId, (s) =>
      decide(s, approved, { client, store: pgStore, actor: who.actor, today: new Date().toISOString().slice(0, 10) }, typeof note === 'string' ? note.slice(0, 500) : undefined));
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Anthropic.APIError) return NextResponse.json({ error: 'assistant unavailable' }, { status: 502 });
    if (e instanceof Error && /nothing pending/.test(e.message)) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
