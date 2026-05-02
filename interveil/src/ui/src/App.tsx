import React, { useState, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';
import { StatusIndicator } from './components/StatusIndicator';
import { SessionList } from './components/SessionList';
import { TraceView } from './components/TraceView';

type Tab = 'trace' | 'gateway';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('trace');
  const [wsToken, setWsToken] = useState('');

  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
    activeSession,
    activeEvents,
    loading,
    addLiveEvent,
  } = useSessions();

  const { status, authRequired, connect } = useWebSocket(addLiveEvent);

  const hasSessions = sessions.length > 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg)',
      overflow: 'hidden',
    }}>
      {/* Top bar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '0 20px',
        height: '52px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: 28, height: 28,
            background: 'linear-gradient(135deg, #3B82F6, #A855F7)',
            borderRadius: '6px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', fontWeight: 700, color: 'white',
          }}>V</div>
          <span style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.02em' }}>
            Interveil
          </span>
        </div>

        <div style={{ display: 'flex', gap: '2px' }}>
          {(['trace', 'gateway'] as Tab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: activeTab === tab ? 'rgba(59,130,246,0.15)' : 'transparent',
                border: 'none',
                color: activeTab === tab ? 'var(--blue)' : 'var(--text-muted)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 12px',
                fontSize: '13px',
                fontWeight: activeTab === tab ? 600 : 400,
                textTransform: 'capitalize',
                cursor: 'pointer',
              }}
            >{tab === 'gateway' ? 'Gateway' : 'Trace'}</button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <StatusIndicator status={status} />
      </header>

      {/* Auth required banner */}
      {authRequired && (
        <div style={{
          background: 'rgba(234,179,8,0.12)', borderBottom: '1px solid rgba(234,179,8,0.3)',
          padding: '10px 20px', display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0,
        }}>
          <span style={{ fontSize: '13px', color: '#fbbf24', flex: 1 }}>
            Server has authentication enabled. Enter your Interveil token to connect:
          </span>
          <input
            value={wsToken}
            onChange={e => setWsToken(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && connect(wsToken)}
            placeholder="Paste token from POST /api/v1/auth/login"
            style={{
              background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(234,179,8,0.4)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text)',
              padding: '5px 10px', fontSize: '12px', width: '340px', fontFamily: 'var(--font-mono)',
            }}
          />
          <button
            onClick={() => connect(wsToken)}
            style={{
              background: 'rgba(234,179,8,0.2)', border: '1px solid rgba(234,179,8,0.4)',
              color: '#fbbf24', borderRadius: 'var(--radius-sm)',
              padding: '5px 14px', fontSize: '12px', cursor: 'pointer', fontWeight: 600,
            }}
          >Connect</button>
        </div>
      )}

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {activeTab === 'trace' && (
          <>
            {hasSessions && (
              <SessionList
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={setActiveSessionId}
              />
            )}
            {loading ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
                Loading...
              </div>
            ) : (
              <TraceView session={activeSession} events={activeEvents} />
            )}
          </>
        )}

        {activeTab === 'gateway' && <GatewayTab />}
      </div>
    </div>
  );
}

interface GatewayStats {
  recent_requests: Array<{ model: string; tokens: number; latency: number; time: string }>;
  total_tokens: number;
  avg_latency_ms: number;
}

function GatewayTab() {
  const [stats, setStats] = useState<GatewayStats | null>(null);

  useEffect(() => {
    const fetch_ = () =>
      fetch('/api/v1/gateway/stats')
        .then(r => r.json() as Promise<{ ok: boolean } & GatewayStats>)
        .then(d => { if (d.ok) setStats(d); })
        .catch(() => {});

    fetch_();
    const id = setInterval(fetch_, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '32px', display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '860px' }}>
      <div>
        <h2 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>Gateway</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
          Point your IDE or agent tool at Interveil instead of directly at the LLM provider. Interveil will intercept, log, and forward every request transparently.
        </p>
      </div>

      {/* Live stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
        <StatCard label="Requests proxied" value={String(stats?.recent_requests.length ?? 0)} sub="last 10 shown" />
        <StatCard label="Total tokens" value={stats ? stats.total_tokens.toLocaleString() : '—'} sub="across recent requests" />
        <StatCard label="Avg latency" value={stats ? `${stats.avg_latency_ms} ms` : '—'} sub="across recent requests" />
      </div>

      {stats && stats.recent_requests.length > 0 && (
        <Section title="Recent LLM Requests">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                {['Time', 'Model', 'Tokens', 'Latency'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.recent_requests.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '7px 8px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                    {new Date(r.time).toLocaleTimeString()}
                  </td>
                  <td style={{ padding: '7px 8px', color: 'var(--text)' }}>{r.model}</td>
                  <td style={{ padding: '7px 8px', color: 'var(--text-muted)' }}>{r.tokens.toLocaleString()}</td>
                  <td style={{ padding: '7px 8px', color: 'var(--text-muted)' }}>{r.latency} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="LLM Proxy — OpenAI-Compatible">
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
          Set your base URL to <Code>http://localhost:3000/v1/proxy</Code> in your IDE or tool.
        </p>
        <IDEInstructions />
      </Section>

      <Section title="MCP Proxy">
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
          Send MCP tool calls to <Code>POST http://localhost:3000/v1/mcp</Code>. Configure your MCP server with:
        </p>
        <CodeBlock code={`interveil serve --mcp-server http://localhost:8080\n\n# Or via environment variable:\nMCP_SERVER_URL=http://localhost:8080 interveil serve`} />
      </Section>

      <Section title="Auth">
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
          <strong>Passthrough mode (default):</strong> Your IDE sends its API key in the{' '}
          <Code>Authorization: Bearer</Code> header as normal. Interveil forwards it to the real provider and never stores it.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px' }}>
          <strong>Stored key mode:</strong> Set <Code>OPENAI_API_KEY</Code>, <Code>ANTHROPIC_API_KEY</Code>, or <Code>GEMINI_API_KEY</Code> as environment variables.
        </p>
      </Section>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '16px',
    }}>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>{sub}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '20px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)' }}>{title}</h3>
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code style={{ background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4, fontSize: '12px' }}>
      {children}
    </code>
  );
}

function IDEInstructions() {
  const tools = [
    { name: 'Cursor', instruction: 'Settings → Models → Base URL', value: 'http://localhost:3000/v1/proxy' },
    { name: 'Continue.dev', instruction: 'config.json → "apiBase"', value: 'http://localhost:3000/v1/proxy' },
    { name: 'Generic', instruction: 'Any OpenAI-compatible tool — set base URL to', value: 'http://localhost:3000/v1/proxy' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {tools.map(t => (
        <div key={t.name} style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-sm)',
          padding: '10px 12px', border: '1px solid var(--border)',
        }}>
          <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text)', minWidth: '80px' }}>{t.name}</span>
          <span style={{ color: 'var(--text-dim)', fontSize: '12px' }}>{t.instruction}:</span>
          <code style={{ fontSize: '12px', color: 'var(--blue)', background: 'rgba(59,130,246,0.1)', padding: '2px 6px', borderRadius: 4 }}>{t.value}</code>
        </div>
      ))}
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre style={{
      background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      padding: '12px', fontSize: '12px', fontFamily: 'var(--font-mono)',
      color: 'var(--text)', overflow: 'auto', whiteSpace: 'pre-wrap',
    }}>{code}</pre>
  );
}
