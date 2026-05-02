import React from 'react';
import { TraceEvent } from '../types';
import { StepBadge } from './StepBadge';
import { JsonViewer } from './JsonViewer';

interface Props {
  event: TraceEvent | null;
  onClose: () => void;
}

export function DetailPanel({ event, onClose }: Props) {
  if (!event) return null;

  const handleCopyAll = () => {
    void navigator.clipboard.writeText(JSON.stringify(event, null, 2));
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--surface)',
      borderLeft: '1px solid var(--border)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <StepBadge stepType={event.step_type} />
          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Step {event.step_index}</span>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={handleCopyAll}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 10px',
              fontSize: '11px',
            }}
          >
            Copy JSON
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 8px',
              fontSize: '14px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {event.model && (
            <Chip label="Model" value={event.model} />
          )}
          {event.duration_ms !== undefined && (
            <Chip label="Duration" value={`${event.duration_ms}ms`} />
          )}
          {event.token_usage?.total_tokens && (
            <Chip label="Tokens" value={String(event.token_usage.total_tokens)} />
          )}
          <Chip label="Time" value={new Date(event.timestamp).toLocaleTimeString()} />
        </div>

        {event.token_usage && (event.token_usage.prompt_tokens || event.token_usage.completion_tokens) && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {event.token_usage.prompt_tokens !== undefined && (
              <Chip label="Prompt tokens" value={String(event.token_usage.prompt_tokens)} />
            )}
            {event.token_usage.completion_tokens !== undefined && (
              <Chip label="Completion tokens" value={String(event.token_usage.completion_tokens)} />
            )}
          </div>
        )}

        <JsonViewer data={event.input} label="Input" />
        <JsonViewer data={event.output} label="Output" />

        {event.error !== undefined && event.error !== null && (
          <div>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Error
            </div>
            <JsonViewer data={event.error} />
          </div>
        )}

        {event.metadata && Object.keys(event.metadata).length > 0 && (
          <JsonViewer data={event.metadata} label="Metadata" />
        )}
      </div>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      background: 'rgba(0,0,0,0.3)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      padding: '3px 8px',
      fontSize: '11px',
    }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ color: 'var(--text)' }}>{value}</span>
    </div>
  );
}
