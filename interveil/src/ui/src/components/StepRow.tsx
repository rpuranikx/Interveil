import React from 'react';
import { TraceEvent } from '../types';
import { StepBadge } from './StepBadge';

interface Props {
  event: TraceEvent;
  sessionStart: string;
  isSelected: boolean;
  isPrecededByError: boolean;
  onClick: () => void;
}

function relativeTime(sessionStart: string, eventTimestamp: string): string {
  const diff = new Date(eventTimestamp).getTime() - new Date(sessionStart).getTime();
  if (diff < 0) return '+0ms';
  if (diff < 1000) return `+${diff}ms`;
  return `+${(diff / 1000).toFixed(1)}s`;
}

function summarize(data: unknown): string {
  if (data === null || data === undefined) return '—';
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return str.length > 120 ? str.slice(0, 120) + '…' : str;
  } catch {
    return '—';
  }
}

export function StepRow({ event, sessionStart, isSelected, isPrecededByError, onClick }: Props) {
  const isError = event.step_type === 'ERROR' || event.step_type === 'COMMAND_BLOCKED' || event.step_type === 'TOOL_PERMISSION_DENIED' || event.step_type === 'POLICY_VIOLATION';

  const borderColor = isError ? 'var(--red)' : isPrecededByError ? 'var(--yellow)' : 'transparent';
  const bgColor = isSelected
    ? 'var(--surface2)'
    : isError
    ? 'rgba(239,68,68,0.06)'
    : isPrecededByError
    ? 'rgba(234,179,8,0.04)'
    : 'transparent';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 16px',
        borderLeft: `3px solid ${borderColor}`,
        background: bgColor,
        cursor: 'pointer',
        transition: 'background 0.1s',
        borderBottom: '1px solid var(--border)',
        minWidth: 0,
      }}
      onMouseEnter={e => {
        if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--surface2)';
      }}
      onMouseLeave={e => {
        if (!isSelected) (e.currentTarget as HTMLElement).style.background = bgColor;
      }}
    >
      <span style={{ color: 'var(--text-dim)', fontSize: '11px', minWidth: '22px', textAlign: 'right', flexShrink: 0 }}>
        {event.step_index}
      </span>

      <StepBadge stepType={event.step_type} small />

      <span style={{ color: 'var(--text-dim)', fontSize: '11px', flexShrink: 0 }}>
        {relativeTime(sessionStart, event.timestamp)}
      </span>

      {event.duration_ms !== undefined && (
        <span style={{
          fontSize: '11px',
          color: 'var(--text-dim)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '1px 5px',
          flexShrink: 0,
        }}>
          {event.duration_ms}ms
        </span>
      )}

      <span style={{
        color: 'var(--text-muted)',
        fontSize: '12px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
        minWidth: 0,
      }}>
        {summarize(event.output ?? event.input)}
      </span>
    </div>
  );
}
