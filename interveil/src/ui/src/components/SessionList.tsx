import React from 'react';
import { Session } from '../types';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--blue)',
  completed: 'var(--green)',
  failed: 'var(--red)',
};

export function SessionList({ sessions, activeSessionId, onSelect }: Props) {
  if (sessions.length === 0) return null;

  return (
    <div style={{
      width: '220px',
      flexShrink: 0,
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      background: 'var(--surface)',
    }}>
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--border)',
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--text-dim)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        flexShrink: 0,
      }}>
        Sessions
      </div>
      {sessions.map(session => (
        <div
          key={session.session_id}
          onClick={() => onSelect(session.session_id)}
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid var(--border)',
            cursor: 'pointer',
            background: session.session_id === activeSessionId ? 'var(--surface2)' : 'transparent',
            borderLeft: session.session_id === activeSessionId ? '2px solid var(--blue)' : '2px solid transparent',
            transition: 'background 0.1s',
          }}
          onMouseEnter={e => {
            if (session.session_id !== activeSessionId) {
              (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
            }
          }}
          onMouseLeave={e => {
            if (session.session_id !== activeSessionId) {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: STATUS_COLOR[session.status] ?? 'var(--gray)',
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {session.name ?? session.session_id.slice(0, 8) + '…'}
            </span>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-dim)', paddingLeft: '12px' }}>
            {session.agent_id ?? new Date(session.started_at).toLocaleTimeString()}
          </div>
        </div>
      ))}
    </div>
  );
}
