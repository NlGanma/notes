import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, CircleAlert, Copy, CornerDownLeft, Link2, FilePlus2, PlayCircle, RefreshCw, Search, Settings, TriangleAlert } from 'lucide-react';
import type { ChatMsg, MsgPhase, SourceRef } from '../../state/assistant';
import { citedInAnswer, normalizeOutside, OWN_OPEN, renderMarkdown, withoutOpenMath } from '../../lib/ai/markdown';
import { applyGrounding, type GroundingReport } from '../../lib/ai/grounding';
import { shownOf, type CheckSummary } from '../../lib/ai/answer';
import { LABELS } from '../../lib/ai/policy';
import { markersToText, splitSentences } from '../../lib/ai/verify';
import { openSource, sourceTitle } from './Citations';
import { useUI } from '../../state/ui';
import { cx, plural } from '../../lib/util';

function phaseLabel(phase: MsgPhase, msg: ChatMsg): string {
  switch (phase) {
    case 'reading':
      return msg.grounding === 'homework' ? 'Reading your linked notes…' : 'Searching your notes…';
    case 'loading':
      return 'Loading the model. The first answer takes a moment…';
    case 'retrying':
      return 'The model server is busy. Retrying…';
    case 'repairing':
      return 'Tidying up the format…';
    case 'general':
      return msg.ownOnly ? 'Answering from the AI’s own knowledge…' : 'Answering what your notes don’t cover…';
    case 'checking':
      return LABELS.doubleChecking;
  }
}

/** The markdown a message shows: the checked version (see shownOf), without a formula still being written. */
export function shownMarkdown(msg: ChatMsg): string {
  const md = shownOf(msg);
  return msg.status === 'done' && !msg.truncated ? md : withoutOpenMath(md);
}

/** Plain markdown for Copy (inline marks spelled out), with the notes its [n] point to. */
export function copyText(msg: ChatMsg): string {
  const md = shownMarkdown(msg);
  const cited = citedInAnswer(md, msg.sources?.length);
  const sources = (msg.sources ?? []).filter((s) => cited.has(s.n)).map((s) => `[${s.n}] ${[sourceTitle(s), s.section].filter(Boolean).join(' › ')}`);
  return sources.length ? `${markersToText(md)}\n\nSources: ${sources.join(' · ')}` : markersToText(md);
}

/** Older replies (from before the notes-only check) get the in-place citation check; the AI's own answers are labelled already. */
export function needsLegacyCheck(msg: ChatMsg, citations?: boolean): boolean {
  return !!msg.grounding && !msg.check && !msg.ownOnly && msg.status === 'done' && !!citations;
}

/** "Your notes don't cover this…" — written by the app, above the answer. */
function CoverageBanner({ msg, onForce, onLink }: { msg: ChatMsg; onForce?(): void; onLink?(): void }) {
  const b = msg.banner;
  if (!b) return null;
  const text = {
    none: LABELS.noneBody,
    noneOff: LABELS.noneOff(msg.grounding === 'library'),
    noLinked: LABELS.noLinked,
    collapsed: LABELS.collapsed,
    partial: b === 'partial' && shownMarkdown(msg).includes(OWN_OPEN) ? LABELS.partialTagged : LABELS.partial,
    mayCover: LABELS.mayCover,
    // The example from the AI's own knowledge streams into `shown`.
    noExample: msg.ownOnly && (msg.shown || msg.content) ? LABELS.noneBody : '',
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
              {s.section || sourceTitle(s)}
            </button>
          ))}
        </div>
      )}
      {/* Only when the notes weren't searched for this answer (a search is forced, or checked); with no notes linked, linking them is what helps. */}
      {none && b !== 'noLinked' && !msg.forced && !msg.check && onForce && msg.status !== 'streaming' && (
        <button className="link-btn coverage-force" onClick={onForce}>
          <Search size={12} /> {LABELS.searchAnyway}
        </button>
      )}
      {b === 'noLinked' && onLink && msg.status !== 'streaming' && (
        <button className="link-btn coverage-link" onClick={onLink}>
          <Link2 size={12} /> Link notes…
        </button>
      )}
    </div>
  );
}

export const MessageView = memo(function MessageView({
  msg,
  onCite,
  onInsert,
  onRegenerate,
  onContinue,
  onForce,
  onLink,
  onSave,
  saved,
  iconActions,
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
  /** Homework with no notes linked: link some. */
  onLink?(): void;
  /** "Save as note": keeps an answer from Ask your notes as a note of its own. */
  onSave?(): void;
  saved?: boolean;
  /** Copy and Retry as icon buttons (with tooltips) instead of labelled ones. */
  iconActions?: boolean;
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
  const legacy = needsLegacyCheck(msg, citations);
  useLayoutEffect(() => {
    const el = mdRef.current;
    if (!el || !legacy) {
      setReport(null);
      return;
    }
    const sources = msg.sources ?? [];
    setReport(applyGrounding(el, (n) => sources.find((s) => s.n === n)?.text));
  }, [html, legacy, msg.sources]);

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
                  {/* A snippet of plain text helps; raw TeX or Markdown doesn't (the tooltip has it all). */}
                  {a.text && !/[$\\]/.test(a.text) ? `: ${a.text.slice(0, 60)}${a.text.length > 60 ? '…' : ''}` : ''}
                </span>
              ),
            )}
          </div>
        )}
        <div className="msg-bubble">{msg.label ?? msg.content}</div>
      </div>
    );
  }

  const streaming = msg.status === 'streaming';
  return (
    <div className={cx('msg is-bot', streaming && 'is-streaming')}>
      {msg.thinking && (
        <button className={cx('msg-thinking', showThinking && 'is-open')} onClick={() => setShowThinking((v) => !v)}>
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
      <CoverageBanner msg={msg} onForce={onForce} onLink={onLink} />
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
      {/* Also while all that arrived is a formula still being written (not shown yet). */}
      {streaming && (md || msg.content) && <span className="caret" />}
      {unchecked && md && <div className="msg-checking">Every sentence is checked against your notes when the answer is done.</div>}
      {msg.added && msg.added.length > 0 && (
        <div className="msg-added">
          <CircleAlert size={13} /> This adds things that aren’t in your passage: {msg.added.map((a) => `“${a}”`).join(', ')}
        </div>
      )}
      {msg.grounding === 'transform' && msg.status === 'done' && msg.content && /^Translate/.test(msg.question ?? '') && (
        <div className="msg-checking">{LABELS.translateNote}</div>
      )}
      {/* "…with your notes' method" only when some of the answer is from the notes. */}
      {msg.check?.derived && msg.check.supported > 0 && msg.banner !== 'collapsed' && msg.status === 'done' ? (
        <div className="msg-checking">{LABELS.computed}</div>
      ) : null}
      {msg.dropped ? (
        <div className="msg-added">
          <CircleAlert size={13} /> Left out {plural(msg.dropped, 'item')} that no passage of your notes backed.
        </div>
      ) : null}
      {/* Retry sits here only when there is no answer to show (otherwise it's under the answer). */}
      {msg.status === 'error' && (
        <div className="msg-error">
          <TriangleAlert size={15} />
          <div>
            <div>{msg.error}</div>
            <div className="msg-error-actions">
              {onRegenerate && !md && (
                <button className="link-btn" onClick={onRegenerate}>
                  <RefreshCw size={12} /> Retry
                </button>
              )}
              <button className="link-btn" onClick={() => useUI.getState().openSettings('ai')}>
                <Settings size={12} /> AI settings
              </button>
            </div>
          </div>
        </div>
      )}
      {msg.status === 'stopped' && (
        <div className="msg-stopped">
          Stopped
          {onRegenerate && !md && (
            <button className="link-btn" onClick={onRegenerate}>
              <RefreshCw size={12} /> Retry
            </button>
          )}
        </div>
      )}
      {msg.check && msg.status === 'done' && !msg.ownOnly && (
        <CheckBar check={msg.check} own={ownSentences(md)} showWeak={showUncited} onToggle={() => setShowUncited((v) => !v)} />
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
          <PlayCircle size={14} /> The answer was cut off. Continue
        </button>
      )}
      {children}
      {!streaming && md && (
        <div className="msg-actions">
          <button
            className={cx('msg-act', iconActions && 'is-icon')}
            title={iconActions ? (copied ? 'Copied' : 'Copy') : undefined}
            aria-label={iconActions ? 'Copy' : undefined}
            onClick={() => {
              navigator.clipboard?.writeText(copyText(msg)).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            {iconActions ? copied ? <Check size={16} /> : <Copy size={16} /> : <>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}</>}
          </button>
          {onRegenerate && (
            <button className={cx('msg-act', iconActions && 'is-icon')} onClick={onRegenerate} title={iconActions ? 'Retry' : undefined} aria-label={iconActions ? 'Retry' : undefined}>
              {iconActions ? <RefreshCw size={16} /> : <><RefreshCw size={13} /> Retry</>}
            </button>
          )}
          {/* One labelled action after the icons: put the answer to use. */}
          {onInsert && (
            <button className="msg-act msg-save" onClick={onInsert}>
              <CornerDownLeft size={16} /> Insert into note
            </button>
          )}
          {onSave && (
            <button className="msg-act msg-save" onClick={onSave} disabled={saved}>
              {saved ? <Check size={16} /> : <FilePlus2 size={16} />} {saved ? 'Saved as a note' : 'Save as note'}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/** Sentences in the boxes of the AI's own knowledge (the sentences the check boxed itself are `contained`). */
function ownSentences(md: string): number {
  let n = 0;
  for (const m of normalizeOutside(md).matchAll(/^:::outside\n([\s\S]*?)\n:::[ \t]*$/gm)) n += Math.max(1, splitSentences(m[1]).filter((x) => /\p{L}/u.test(x)).length);
  return n;
}

/**
 * What the notes-only check found, as one quiet line: sentences backed by the notes, and how many are not
 * (each of those is in a labelled box or tagged on screen already).
 */
function CheckBar({ check, own, showWeak, onToggle }: { check: CheckSummary; own: number; showWeak: boolean; onToggle(): void }) {
  const notFound = check.contained + own;
  if (!check.supported && !check.weak && !notFound) return null;
  return (
    <div className={cx('grounding', notFound || check.weak ? 'is-warn' : 'is-clean')}>
      {check.supported > 0 && (
        <span
          className="grounding-item is-cited"
          title={`Each one was checked against the passage it cites${check.repaired ? ` (${plural(check.repaired, 'citation')} added or corrected after checking)` : ''}`}
        >
          {plural(check.supported, 'sentence')} from your notes
        </span>
      )}
      {notFound > 0 && (
        <span className="grounding-item is-outside" title="No passage of your notes backs these, so they are boxed or tagged as the AI’s own knowledge">
          {notFound} not found in your notes
        </span>
      )}
      {check.weak > 0 && (
        <button className={cx('grounding-item is-uncited', showWeak && 'is-on')} onClick={onToggle} title="Related to the cited note, but not clearly the same. Check these.">
          {check.weak} loosely matched · {showWeak ? 'Hide' : 'Show'}
        </button>
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
        <span className="grounding-item is-cited" title={homework ? 'Sentences backed by the notes you linked' : 'Sentences backed by your notes'}>
          {plural(report.cited, 'sentence')} from your notes
        </span>
      )}
      {report.outside > 0 && (
        <span className="grounding-item is-outside" title="Your notes don’t cover this">
          {LABELS.ownParts(report.outside)}
        </span>
      )}
      {(report.uncited > 0 || report.weak > 0) && (
        <button className={cx('grounding-item is-uncited', showUncited && 'is-on')} onClick={onToggle} title="Highlight what isn’t clearly backed by a note">
          {[report.uncited ? `${report.uncited} uncited` : '', report.weak ? `${report.weak} weak ${report.weak === 1 ? 'citation' : 'citations'}` : '']
            .filter(Boolean)
            .join(', ')}{' '}
          · {showUncited ? 'Hide' : 'Show'}
        </button>
      )}
      {homework && sources === 0 && <span className="grounding-item is-outside">No notes linked</span>}
    </div>
  );
}
