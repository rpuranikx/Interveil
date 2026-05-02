import React, { useState, useRef, useEffect } from 'react';
import { TraceEvent, Session } from '../types';
import { StepRow } from './StepRow';
import { DetailPanel } from './DetailPanel';

interface Props {
  session: Session | null;
  events: TraceEvent[];
}

export function TraceView({ session, events }: Props) {
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 60);
  };

  if (!session) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: '12px',
        color: 'var(--text-dim)',
      }}>
        <div style={{ fontSize: '48px', opacity: 0.3 }}>◎</div>
        <div style={{ fontSize: '18px', color: 'var(--text-muted)' }}>Waiting for your agent...</div>
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>Run your agent to see its trace here</div>
      </div>
    );
  }

  // Find error events and their preceding steps
  const errorIndices = new Set(
    events.filter(e =>
      e.step_type === 'ERROR' || e.step_type === 'COMMAND_BLOCKED' || e.step_type === 'TOOL_PERMISSION_DENIED'
    ).map(e => e.step_index)
  );
  const precedingErrorIndices = new Set(
    Array.from(errorIndices).map(i => i - 1).filter(i => i >= 0)
  );

  const firstError = events.find(e => e.step_type === 'ERROR');
  const totalDuration = (() => {
    if (events.length === 0) return null;
    const first = new Date(events[0].timestamp).getTime();
    const last = new Date(events[events.length - 1].timestamp).getTime();
    const diff = last - first;
    return diff < 1000 ? `${diff}ms` : `${(diff / 1000).toFixed(1)}s`;
  })();

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {firstError && (
          <div style={{
            padding: '8px 16px',
            background: 'rgba(239,68,68,0.1)',
            borderBottom: '1px solid rgba(239,68,68,0.3)',
            color: 'var(--red)',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <span>
              ⚠ Failure detected at step {firstError.step_index}
              {firstError.error && typeof firstError.error === 'object' && 'message' in firstError.error
                ? ` — ${(firstError.error as { message: string }).message}`
                : ''}
            </span>
          </div>
        )}

        <div style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexShrink: 0,
          fontSize: '12px',
          color: 'var(--text-muted)',
        }}>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>
            {session.name ?? session.session_id.slice(0, 8)}
          </span>
          <span>{events.length} step{events.length !== 1 ? 's' : ''}</span>
          {totalDuration && <span>{totalDuration} total</span>}
          <span style={{ color: STATUS_COLOR[session.status] ?? 'var(--text-dim)' }}>
            {session.status}
          </span>
        </div>

        <div
          ref={listRef}
          onScroll={handleScroll}
          style={{ flex: 1, overflowY: 'auto' }}
        >
          {events.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
              No events yet for this session
            </div>
          ) : (
            events.map(event => (
              <StepRow
                key={event.event_id}
                event={event}
                sessionStart={session.started_at}
                isSelected={selectedEvent?.event_id === event.event_id}
                isPrecededByError={precedingErrorIndices.has(event.step_index)}
                onClick={() => setSelectedEvent(event.event_id === selectedEvent?.event_id ? null : event)}
              />
            ))
          )}
        </div>
      </div>

      {selectedEvent && (
        <div style={{ width: '38%', flexShrink: 0, overflow: 'hidden' }}>
          <DetailPanel event={selectedEvent} onClose={() => setSelectedEvent(null)} />
        </div>
      )}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--blue)',
  completed: 'var(--green)',
  failed: 'var(--red)',
};
