import React, { useState } from 'react';

interface Props {
  data: unknown;
  label?: string;
}

function colorizeJson(json: string): string {
  return json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = '#60A5FA'; // number
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = '#A78BFA'; // key
          } else {
            cls = '#34D399'; // string
          }
        } else if (/true|false/.test(match)) {
          cls = '#F97316'; // boolean
        } else if (/null/.test(match)) {
          cls = '#94A3B8'; // null
        }
        return `<span style="color:${cls}">${match}</span>`;
      }
    );
}

export function JsonViewer({ data, label }: Props) {
  const [copied, setCopied] = useState(false);

  if (data === undefined || data === null) {
    return (
      <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', fontSize: '12px' }}>
        {label && <div style={{ marginBottom: 4, color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>}
        null
      </div>
    );
  }

  const formatted = JSON.stringify(data, null, 2);
  const highlighted = colorizeJson(formatted);

  const handleCopy = () => {
    void navigator.clipboard.writeText(formatted).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {label && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {label}
          </span>
          <button
            onClick={handleCopy}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 8px',
              fontSize: '11px',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      )}
      <pre
        style={{
          background: 'rgba(0,0,0,0.3)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          padding: '12px',
          fontSize: '12px',
          lineHeight: 1.6,
          overflow: 'auto',
          maxHeight: '300px',
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  );
}
