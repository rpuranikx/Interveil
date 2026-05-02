import React from 'react';
import { WsStatus } from '../hooks/useWebSocket';

interface Props {
  status: WsStatus;
}

export function StatusIndicator({ status }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: status === 'connected' ? 'var(--green)' : status === 'connecting' ? 'var(--yellow)' : 'var(--red)',
          boxShadow: status === 'connected' ? '0 0 6px var(--green)' : 'none',
          animation: status === 'connected' ? 'pulse 2s infinite' : 'none',
        }}
      />
      <span style={{ color: status === 'connected' ? 'var(--green)' : 'var(--text-muted)' }}>
        {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting...' : 'Disconnected — retrying...'}
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
