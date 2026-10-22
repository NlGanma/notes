import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  CornerDownLeft,
  Globe,
  PlayCircle,
  RefreshCw,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import type { ChatMsg, MsgPhase } from '../../state/assistant';
import { renderMarkdown } from '../../lib/ai/markdown';
import { applyGrounding, type GroundingReport } from '../../lib/ai/grounding';
import { useUI } from '../../state/ui';
import { cx, plural } from '../../lib/util';

function phaseLabel(phase: MsgPhase, msg: ChatMsg): string {
  switch (phase) {
    case 'reading':
      return msg.grounding === 'homework' ? 'Reading your linked notes…' : 'Searching your notes…';
    case 'loading':
      return 'Loading the model into memory — the first answer takes a moment…';
    case 'retrying':
      return 'The model server is busy — retrying…';
    case 'repairing':
      return 'Tidying up the format…';
  }
}

function metricsLabel(msg: ChatMsg): string | null {
  const m = msg.metrics;
  if (!m) return null;
  const parts = [`${(m.totalMs / 1000).toFixed(m.totalMs < 10_000 ? 1 : 0)}s`];
  if (m.tokensPerSec) parts.push(`${Math.round(m.tokensPerSec)} tok/s`);
  return parts.join(' · ');
}

export const MessageView = memo(function MessageView({
  msg,
  onCite,
  onInsert,
  onRegenerate,
  onContinue,
  citations,
  children,
}: {
  msg: ChatMsg;
  onCite?(n: number, el: HTMLElement): void;
  onInsert?(): void;
  onRegenerate?(): void;
  onContinue?(): void;
  citations?: boolean;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [report, setReport] = useState<GroundingReport | null>(null);
  const [showUncited, setShowUncited] = useState(false);
  const mdRef = useRef<HTMLDivElement>(null);
  const maxCite = msg.sources?.length;
  const html = useMemo(
    () => (msg.role === 'assistant' ? renderMarkdown(msg.content, { citations, maxCite: citations ? maxCite : undefined }) : ''),
    [msg.content, msg.role, citations, maxCite],
  );

  // Grounding check once the answer is complete: which statements are backed by which note.
  useLayoutEffect(() => {
    const el = mdRef.current;
    if (!el || !msg.grounding || msg.status !== 'done' || !citations) {
      setReport(null);
      return;
    }
    const sources = msg.sources ?? [];
    setReport(applyGrounding(el, (n) => sources.find((s) => s.n === n)?.text));
  }, [html, msg.grounding, msg.status, msg.sources, citations]);

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
      {streaming && !msg.content && !msg.thinking && !msg.phase && (
        <div className="msg-typing" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      )}
      {msg.phase && (
        <div className={cx('msg-phase', `is-${msg.phase}`)}>
          <span className="spinner" /> {phaseLabel(msg.phase, msg)}
        </div>
      )}
      {msg.content && (
        <div
          ref={mdRef}
          className={cx('md', showUncited && 'show-uncited')}
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
      {report && (
        <GroundingBar
          report={report}
          homework={msg.grounding === 'homework'}
          sources={msg.sources?.length ?? 0}
          showUncited={showUncited}
          onToggle={() => setShowUncited((v) => !v)}
        />
      )}
      {msg.truncated && !streaming && onContinue && (
        <button className="msg-continue" onClick={onContinue}>
          <PlayCircle size={14} /> The answer was cut off — continue
        </button>
      )}
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
          {msg.model && (
            <span
              className="msg-model"
              title={
                msg.metrics
                  ? `First token ${msg.metrics.firstTokenMs ? Math.round(msg.metrics.firstTokenMs) + ' ms' : '—'} · ${msg.metrics.tokens} tokens`
                  : undefined
              }
            >
              {msg.model}
              {metricsLabel(msg) && <span className="msg-metrics"> · {metricsLabel(msg)}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

function GroundingBar({
  report,
  homework,
  sources,
  showUncited,
  onToggle,
}: {
  report: GroundingReport;
  homework: boolean;
  sources: number;
  showUncited: boolean;
  onToggle(): void;
}) {
  if (!report.cited && !report.uncited && !report.outside) return null;
  const clean = !report.uncited && !report.weak;
  return (
    <div className={cx('grounding', clean ? 'is-clean' : 'is-warn')}>
      {report.cited > 0 && (
        <span className="grounding-item is-cited" title={homework ? 'Statements backed by the notes you linked' : 'Statements backed by your notes'}>
          <ShieldCheck size={13} /> {plural(report.cited, 'statement')} from your notes
        </span>
      )}
      {report.outside > 0 && (
        <span className="grounding-item is-outside" title="Marked general knowledge — your notes don’t cover this">
          <Globe size={13} /> {report.outside === 1 ? '1 part' : `${report.outside} parts`} not from your notes
        </span>
      )}
      {(report.uncited > 0 || report.weak > 0) && (
        <button className={cx('grounding-item is-uncited', showUncited && 'is-on')} onClick={onToggle} title="Highlight what isn’t clearly backed by a note">
          <CircleAlert size={13} />
          {[report.uncited ? `${report.uncited} uncited` : '', report.weak ? `${report.weak} weak ${report.weak === 1 ? 'citation' : 'citations'}` : '']
            .filter(Boolean)
            .join(' · ')}{' '}
          — {showUncited ? 'hide' : 'show'}
        </button>
      )}
      {homework && sources === 0 && <span className="grounding-item is-outside">No notes linked</span>}
    </div>
  );
}
