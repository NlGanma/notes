import { memo, useMemo, useState } from 'react';
import { Brain, Check, ChevronRight, Copy, CornerDownLeft, RefreshCw, Settings, TriangleAlert } from 'lucide-react';
import type { ChatMsg } from '../../state/assistant';
import { renderMarkdown } from '../../lib/ai/markdown';
import { useUI } from '../../state/ui';
import { cx } from '../../lib/util';

export const MessageView = memo(function MessageView({
  msg,
  onCite,
  onInsert,
  onRegenerate,
  citations,
  children,
}: {
  msg: ChatMsg;
  onCite?(n: number, el: HTMLElement): void;
  onInsert?(): void;
  onRegenerate?(): void;
  citations?: boolean;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const html = useMemo(() => (msg.role === 'assistant' ? renderMarkdown(msg.content, { citations }) : ''), [msg.content, msg.role, citations]);

  if (msg.role === 'user') {
    return (
      <div className="msg is-user">
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="msg-attachments">
            {msg.attachments.map((a) =>
              a.kind === 'image' && a.image ? (
                <img key={a.id} className="msg-att-img" src={`data:image/png;base64,${a.image}`} alt={a.label} />
              ) : (
                <span key={a.id} className="msg-att-chip" title={a.text}>
                  {a.label}
                  {a.text ? `: ${a.text.slice(0, 60)}${a.text.length > 60 ? '…' : ''}` : ''}
                </span>
              ),
            )}
          </div>
        )}
        <div className="msg-bubble">{msg.content}</div>
      </div>
    );
  }

  const streaming = msg.status === 'streaming';
  return (
    <div className={cx('msg is-bot', streaming && 'is-streaming')}>
      {msg.thinking && (
        <button className={cx('msg-thinking', showThinking && 'is-open')} onClick={() => setShowThinking((v) => !v)}>
          <Brain size={13} />
          {streaming && !msg.content ? 'Thinking…' : 'Reasoning'}
          <ChevronRight size={12} className="chev" />
        </button>
      )}
      {msg.thinking && showThinking && <div className="msg-thinking-body">{msg.thinking}</div>}
      {streaming && !msg.content && !msg.thinking && (
        <div className="msg-typing" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      )}
      {msg.content && (
        <div
          className="md"
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const cite = (e.target as HTMLElement).closest('.cite') as HTMLElement | null;
            if (cite && onCite) onCite(Number(cite.dataset.cite), cite);
          }}
        />
      )}
      {streaming && msg.content && <span className="caret" />}
      {msg.status === 'error' && (
        <div className="msg-error">
          <TriangleAlert size={15} />
          <div>
            <div>{msg.error}</div>
            <button className="link-btn" onClick={() => useUI.getState().openSettings('ai')}>
              <Settings size={12} /> AI settings
            </button>
          </div>
        </div>
      )}
      {msg.status === 'stopped' && <div className="msg-stopped">Stopped</div>}
      {children}
      {!streaming && msg.content && (
        <div className="msg-actions">
          <button
            className="msg-act"
            onClick={() => {
              navigator.clipboard?.writeText(msg.content).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
          </button>
          {onInsert && (
            <button className="msg-act" onClick={onInsert}>
              <CornerDownLeft size={13} /> Insert into note
            </button>
          )}
          {onRegenerate && (
            <button className="msg-act" onClick={onRegenerate}>
              <RefreshCw size={13} /> Retry
            </button>
          )}
          {msg.model && <span className="msg-model">{msg.model}</span>}
        </div>
      )}
    </div>
  );
});
