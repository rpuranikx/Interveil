import React from 'react';
import { STEP_COLORS, STEP_LABELS } from '../types';

interface Props {
  stepType: string;
  small?: boolean;
}

export function StepBadge({ stepType, small }: Props) {
  const color = STEP_COLORS[stepType] ?? '#6B7280';
  const label = STEP_LABELS[stepType] ?? stepType;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: small ? '1px 6px' : '2px 8px',
        borderRadius: 'var(--radius-sm)',
        fontSize: small ? '10px' : '11px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        background: `${color}20`,
        color,
        border: `1px solid ${color}40`,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}
