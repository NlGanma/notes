import { useAI } from '../../state/ai';
import { useUI } from '../../state/ui';

export type Availability = 'online' | 'loading' | 'offline' | 'nomodel';

/** Whether the local model can answer: running, still starting, not running, or running with no chat model picked. */
export function useAvailability(): Availability {
  return useAI((s) => (s.status === 'online' ? (s.chatModel ? 'online' : 'nomodel') : s.status === 'offline' ? 'offline' : 'loading'));
}

const TEXT: Record<Exclude<Availability, 'online'>, string> = {
  loading: 'Starting the local model…',
  offline: 'Local AI isn’t running',
  nomodel: 'No chat model chosen',
};

/**
 * The line a composer shows above its text while the local model can't answer yet. Typing still works;
 * Send waits for a model (while it is only starting, a question just waits for it).
 */
export function ComposerStatus({ availability }: { availability: Availability }) {
  if (availability === 'online') return null;
  return (
    <div className={`composer-status is-${availability}`} role="status">
      <span className="composer-status-dot" aria-hidden />
      <span className="composer-status-text">{TEXT[availability]}</span>
      <button className="composer-status-link" onClick={() => useUI.getState().openSettings('ai')}>
        Open settings
      </button>
    </div>
  );
}
