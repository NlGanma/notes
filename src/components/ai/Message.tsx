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
  Search,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import type { ChatMsg, MsgPhase, SourceRef } from '../../state/assistant';
import { renderMarkdown } from '../../lib/ai/markdown';
import { applyGrounding, type GroundingReport } from '../../lib/ai/grounding';
import type { CheckSummary } from '../../lib/ai/answer';
import { LABELS } from '../../lib/ai/policy';
import { markersToText } from '../../lib/ai/verify';
import { openSource } from './Citations';
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
    case 'general':
      return msg.ownOnly ? 'Answering from the AI’s own knowledge…' : 'Answering what your notes don’t cover…';
    case 'checking':
      return LABELS.doubleChecking;
  }
}

/** The markdown a message shows: the checked version when there is one. */
export function shownMarkdown(msg: ChatMsg): string {
  if (msg.shown !== undefined) return msg.shown;
  // The notes don't cover it: the reply streams straight into the labelled box.
  return msg.ownOnly && msg.content ? `:::outside\n${msg.content}` : msg.content;
}

/** Plain markdown for Copy (inline marks spelled out). */
export function copyText(msg: ChatMsg): string {
  return markersToText(shownMarkdown(msg));
}

/** "Your notes don't cover this…" — written by the app, above the answer. */
function CoverageBanner({ msg, onForce }: { msg: ChatMsg; onForce?(): void }) {
  const b = msg.banner;
  if (!b) return null;
  const text = {
    none: LABELS.noneBody,
    noneOff: LABELS.noneOff,
    noLinked: LABELS.noLinked,
    collapsed: LABELS.collapsed,
    partial: LABELS.partial,
    mayCover: LABELS.mayCover,
    noExample: msg.ownOnly && msg.content ? LABELS.noneBody : '',
  }[b];
  const none = b !== 'partial';
  return (
    <div className={cx('coverage-banner', none ? 'is-none' : 'is-partial')}>
      {(b === 'none' || b === 'noneOff') && <div className="coverage-title">{LABELS.noneTitle}</div>}
      {b === 'noExample' && <div className="coverage-title">{LABELS.exampleNone}</div>}
      <div className="coverage-text">{text}</div>
      {msg.gaps && msg.gaps.length > 0 && (
        <ul className="coverage-gaps">
          {msg.gaps.map((g) => (
            <li key={g}>{LABELS.gap(g)}</li>
          ))}
        </ul>
      )}
      {none && msg.nearest && msg.nearest.length > 0 && (
        <div className="coverage-nearest">
          <span className="coverage-nearest-label">{LABELS.nearest}</span>
          {msg.nearest.map((s: SourceRef) => (
            <button key={s.n} className="coverage-chip" onClick={() => openSource(s)}>
              {s.section || s.title}
            </button>
          ))}
        </div>
      )}
      {none && b !== 'collapsed' && onForce && msg.status !== 'streaming' && (
        <button className="link-btn coverage-force" onClick={onForce}>
          <Search size={12} /> {LABELS.searchAnyway}
        </button>
      )}
    </div>
  );
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
  onForce,
  citations,
  children,
}: {
  msg: ChatMsg;
  onCite?(n: number, el: HTMLElement): void;
  onInsert?(): void;
  onRegenerate?(): void;
  onContinue?(): void;
  /** "Search my notes anyway" after the coverage check said they don't cover it. */
  onForce?(): void;
  citations?: boolean;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [report, setReport] = useState<GroundingReport | null>(null);
  const [showUncited, setShowUncited] = useState(false);
  const mdRef = useRef<HTMLDivElement>(null);
  const maxCite = msg.sources?.length;
  const md = msg.role === 'assistant' ? shownMarkdown(msg) : '';
  const html = useMemo(
    () => (msg.role === 'assistant' ? renderMarkdown(md, { citations, maxCite: citations ? maxCite : undefined }) : ''),
    [md, msg.role, citations, maxCite],
  );
  // A grounded reply is checked against the notes when it finishes; until then it is shown as unchecked.
  const unchecked = msg.status === 'streaming' && !msg.ownOnly && msg.shown === undefined && !!msg.grounding && msg.grounding !== 'transform';

  // Older messages (before the notes-only check) still get the in-place citation check.
  useLayoutEffect(() => {
    const el = mdRef.current;
    if (!el || !msg.grounding || msg.check || msg.status !== 'done' || !citations) {
      setReport(null);
      return;
    }
    const sources = msg.sources ?? [];
    setReport(applyGrounding(el, (n) => sources.find((s) => s.n === n)?.text));
  }, [html, msg.grounding, msg.check, msg.status, msg.sources, citations]);

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
      <CoverageBanner msg={msg} onForce={onForce} />
      {msg.phase && (
        <div className={cx('msg-phase', `is-${msg.phase}`)}>
          <span className="spinner" /> {phaseLabel(msg.phase, msg)}
        </div>
      )}
      {md && (
        <div
          ref={mdRef}
          className={cx('md', showUncited && 'show-uncited', unchecked && 'is-unchecked')}
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const cite = (e.target as HTMLElement).closest('.cite') as HTMLElement | null;
            if (cite && onCite) onCite(Number(cite.dataset.cite), cite);
          }}
        />
      )}
      {streaming && md && <span className="caret" />}
      {unchecked && md && <div className="msg-checking">Every sentence is checked against your notes when the answer is done.</div>}
      {msg.added && msg.added.length > 0 && (
        <div className="msg-added">
          <CircleAlert size={13} /> This adds things that aren’t in your passage: {msg.added.map((a) => `“${a}”`).join(', ')}
        </div>
      )}
      {msg.grounding === 'transform' && msg.status === 'done' && msg.content && /^Translate/.test(msg.question ?? '') && (
        <div className="msg-checking">{LABELS.translateNote}</div>
      )}
      {msg.check?.derived && msg.status === 'done' ? <div className="msg-checking">{LABELS.computed}</div> : null}
      {msg.dropped ? (
        <div className="msg-added">
          <CircleAlert size={13} /> Left out {plural(msg.dropped, 'item')} that no passage of your notes backed.
        </div>
      ) : null}
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
      {msg.status === 'stopped' && (
        <div className="msg-stopped">
          Stopped
          {onRegenerate && !msg.content && (
            <button className="link-btn" onClick={onRegenerate}>
              <RefreshCw size={12} /> Retry
            </button>
          )}
        </div>
      )}
      {msg.check && msg.status === 'done' && !msg.ownOnly && (
        <CheckBar check={msg.check} general={!!msg.shown?.includes(':::outside\n')} showWeak={showUncited} onToggle={() => setShowUncited((v) => !v)} />
      )}
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
      {!streaming && md && (
        <div className="msg-actions">
          <button
            className="msg-act"
            onClick={() => {
              navigator.clipboard?.writeText(copyText(msg)).catch(() => undefined);
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

/** What the notes-only check found: backed statements, moved ones, the model's own parts. */
function CheckBar({ check, general, showWeak, onToggle }: { check: CheckSummary; general: boolean; showWeak: boolean; onToggle(): void }) {
  const own = check.outside + (general ? 1 : 0);
  if (!check.supported && !check.weak && !check.contained && !own) return null;
  const clean = !check.contained && !check.weak && !own;
  return (
    <div className={cx('grounding', clean ? 'is-clean' : 'is-warn')}>
      {check.supported > 0 && (
        <span className="grounding-item is-cited" title="Each one was checked against the passage it cites">
          <ShieldCheck size={13} /> {plural(check.supported, 'statement')} from your notes
        </span>
      )}
      {check.contained > 0 && (
        <span className="grounding-item is-outside" title="No passage of your notes backs these, so they are boxed as the AI’s own knowledge">
          <Globe size={13} /> {check.contained === 1 ? '1 sentence' : `${check.contained} sentences`} not found in your notes
        </span>
      )}
      {own > 0 && (
        <span className="grounding-item is-outside" title="The AI’s own knowledge — your notes don’t cover this">
          <Globe size={13} /> {own === 1 ? '1 part' : `${own} parts`} from the AI’s own knowledge
        </span>
      )}
      {check.weak > 0 && (
        <button className={cx('grounding-item is-uncited', showWeak && 'is-on')} onClick={onToggle} title="Related to the cited note, but not clearly the same — check these">
          <CircleAlert size={13} /> {check.weak} loosely matched — {showWeak ? 'hide' : 'show'}
        </button>
      )}
      {check.repaired > 0 && (
        <span className="grounding-item is-repaired" title="Nib added or corrected these citations after checking them">
          {plural(check.repaired, 'source')} added by Nib
        </span>
      )}
    </div>
  );
}

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
