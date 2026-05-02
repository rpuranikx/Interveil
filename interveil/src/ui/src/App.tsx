import React, { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';
import { StatusIndicator } from './components/StatusIndicator';
import { SessionList } from './components/SessionList';
import { TraceView } from './components/TraceView';

type Tab = 'trace' | 'gateway';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('trace');

  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
    activeSession,
    activeEvents,
    loading,
    addLiveEvent,
  } = useSessions();

  const { status } = useWebSocket(addLiveEvent);

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
            width: 28,
            height: 28,
            background: 'linear-gradient(135deg, #3B82F6, #A855F7)',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 700,
            color: 'white',
          }}>
            V
          </div>
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
              }}
            >
              {tab === 'gateway' ? 'Gateway' : 'Trace'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <StatusIndicator status={status} />
      </header>

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

        {activeTab === 'gateway' && (
          <GatewayTab />
        )}
      </div>
    </div>
  );
}

function GatewayTab() {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '32px', display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '800px' }}>
      <div>
        <h2 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>Gateway</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
          Point your IDE or agent tool at Interveil instead of directly at the LLM provider. Interveil will intercept, log, and forward every request transparently.
        </p>
      </div>

      <Section title="LLM Proxy — OpenAI-Compatible">
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
          Set your base URL to <code style={{ background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4, fontSize: '12px' }}>http://localhost:3000/v1/proxy</code> in your IDE or tool.
        </p>
        <IDEInstructions />
      </Section>

      <Section title="MCP Proxy">
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
          Send MCP tool calls to <code style={{ background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4, fontSize: '12px' }}>POST http://localhost:3000/v1/mcp</code>. Configure your MCP server with:
        </p>
        <CodeBlock code={`interveil serve --mcp-server http://localhost:8080\n\n# Or via environment variable:\nMCP_SERVER_URL=http://localhost:8080 interveil serve`} />
      </Section>

      <Section title="Auth">
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
          <strong>Passthrough mode (default):</strong> Your IDE sends its API key in the <code style={{ background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4, fontSize: '12px' }}>Authorization: Bearer</code> header as normal. Interveil forwards it to the real provider and never stores it.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px' }}>
          <strong>Stored key mode:</strong> Set <code style={{ background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4, fontSize: '12px' }}>OPENAI_API_KEY</code>, <code style={{ background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4, fontSize: '12px' }}>ANTHROPIC_API_KEY</code>, or <code style={{ background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4, fontSize: '12px' }}>GEMINI_API_KEY</code> as environment variables.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '20px',
    }}>
      <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)' }}>{title}</h3>
      {children}
    </div>
  );
}

function IDEInstructions() {
  const tools = [
    { name: 'Cursor', instruction: 'Settings → Models → Base URL', value: 'http://localhost:3000/v1/proxy' },
    { name: 'Continue.dev', instruction: 'config.json → "apiBase"', value: 'http://localhost:3000/v1/proxy' },
    { name: 'Generic (any OpenAI-compatible tool)', instruction: 'Set base URL to', value: 'http://localhost:3000/v1/proxy' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {tools.map(t => (
        <div key={t.name} style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          background: 'rgba(0,0,0,0.2)',
          borderRadius: 'var(--radius-sm)',
          padding: '10px 12px',
          border: '1px solid var(--border)',
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
      background: 'rgba(0,0,0,0.3)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '12px',
      fontSize: '12px',
      fontFamily: 'var(--font-mono)',
      color: 'var(--text)',
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
    }}>
      {code}
    </pre>
  );
}
