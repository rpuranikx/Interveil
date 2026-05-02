import React from 'react';
import { WsStatus } from '../hooks/useWebSocket';

interface Props {
  status: WsStatus;
}

const CONFIG: Record<WsStatus, { color: string; glow: boolean; pulse: boolean; label: string }> = {
  connected:     { color: 'var(--green)',  glow: true,  pulse: true,  label: 'Live' },
  connecting:    { color: 'var(--yellow)', glow: false, pulse: false, label: 'Connecting...' },
  disconnected:  { color: 'var(--red)',    glow: false, pulse: false, label: 'Disconnected — retrying...' },
  auth_required: { color: '#f59e0b',       glow: false, pulse: false, label: 'Auth required' },
};

export function StatusIndicator({ status }: Props) {
  const cfg = CONFIG[status] ?? CONFIG.disconnected;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: cfg.color,
          boxShadow: cfg.glow ? `0 0 6px ${cfg.color}` : 'none',
          animation: cfg.pulse ? 'pulse 2s infinite' : 'none',
          flexShrink: 0,
        }}
      />
      <span style={{ color: status === 'connected' ? 'var(--green)' : status === 'auth_required' ? '#f59e0b' : 'var(--text-muted)' }}>
        {cfg.label}
      </span>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
