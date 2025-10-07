'use client';
import { useState } from 'react';

type Result = { status: 'done'; text: string } | { status: 'awaiting_approval'; summary: string; toolName: string } | { status: 'stopped'; reason: string };
type Line = { who: 'you' | 'pilot' | 'system'; text: string };

export default function Page() {
  const [sessionId] = useState(() => crypto.randomUUID());
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function show(r: Result & { error?: string }) {
    if ('error' in r && r.error) return setLines((l) => [...l, { who: 'system', text: r.error! }]);
    if (r.status === 'done') setLines((l) => [...l, { who: 'pilot', text: r.text }]);
    if (r.status === 'stopped') setLines((l) => [...l, { who: 'system', text: `Stopped: ${r.reason}` }]);
    setPending(r.status === 'awaiting_approval' ? r.summary : null);
  }

  async function post(path: string, body: object) {
    setBusy(true);
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }) });
      show(await res.json());
    } finally { setBusy(false); }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1>MerchantPilot</h1>
      {lines.map((l, i) => (
        <p key={i} style={{ background: l.who === 'you' ? '#eef4ff' : l.who === 'system' ? '#fff4e5' : '#fff', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap' }}>
          <b>{l.who === 'you' ? 'You' : l.who === 'pilot' ? 'Pilot' : 'Note'}:</b> {l.text}
        </p>
      ))}
      {pending && (
        <div role="alertdialog" aria-label="Approve change" style={{ border: '2px solid #1f5fbf', borderRadius: 8, padding: 12, margin: '12px 0' }}>
          <p><b>Proposed change</b><br />{pending}</p>
          <button disabled={busy} onClick={() => post('/api/approve', { approved: true })}>Approve</button>{' '}
          <button disabled={busy} onClick={() => post('/api/approve', { approved: false, note: prompt('Why not? (optional)') ?? undefined })}>Decline</button>
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); if (!input.trim() || pending) return; setLines((l) => [...l, { who: 'you', text: input }]); post('/api/chat', { message: input }); setInput(''); }}
        style={{ display: 'flex', gap: 8 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} disabled={!!pending} placeholder="e.g. Which products are low on stock?" style={{ flex: 1, padding: 10 }} />
        <button disabled={busy || !!pending}>{busy ? '…' : 'Send'}</button>
      </form>
    </main>
  );
}
