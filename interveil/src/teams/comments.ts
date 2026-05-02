import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../ws/broadcaster.js';

export interface TraceComment {
  id: string;
  session_id: string;
  step_event_id: string;
  author: string;
  text: string;
  mentions: string[];
  resolved: boolean;
  created_at: string;
}

const comments: Map<string, TraceComment[]> = new Map();

export function addComment(
  session_id: string,
  step_event_id: string,
  author: string,
  text: string
): TraceComment {
  const mentions = (text.match(/@\w+/g) ?? []).map(m => m.slice(1));
  const comment: TraceComment = {
    id: uuidv4(),
    session_id,
    step_event_id,
    author,
    text,
    mentions,
    resolved: false,
    created_at: new Date().toISOString(),
  };

  const existing = comments.get(session_id) ?? [];
  existing.push(comment);
  comments.set(session_id, existing);

  broadcast({ type: 'comment_added', comment });
  return comment;
}

export function getComments(session_id: string): TraceComment[] {
  return comments.get(session_id) ?? [];
}

export function resolveComment(commentId: string): boolean {
  for (const [sessionId, sessionComments] of comments) {
    const idx = sessionComments.findIndex(c => c.id === commentId);
    if (idx >= 0) {
      sessionComments[idx] = { ...sessionComments[idx], resolved: true };
      comments.set(sessionId, sessionComments);
      return true;
    }
  }
  return false;
}

export function getUnresolvedCount(session_id: string): number {
  return (comments.get(session_id) ?? []).filter(c => !c.resolved).length;
}
