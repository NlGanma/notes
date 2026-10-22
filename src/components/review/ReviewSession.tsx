import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { BookOpen, Check, ExternalLink, Flag, Keyboard, Lightbulb, MessageCircleQuestion, X } from 'lucide-react';
import { canOverride, factOf, useReview, type Current } from '../../state/review';
import { sectionShown } from '../../lib/review/items';
import { useUI } from '../../state/ui';
import { useAssistant } from '../../state/assistant';
import { useVault } from '../../state/vault';
import { renderMarkdown } from '../../lib/ai/markdown';
import type { Confidence } from '../../lib/review/mastery';
import { cx } from '../../lib/util';
import { toast } from '../common/toast';
import { SELF_GRADES, sessionKey } from './sessionKeys';
import { ReviewOptions } from './ReviewOptions';
import { classStyle, Key, StudyBar } from './parts';

/** Enter that ends a line — not one that picks a candidate in an input method (Chinese, Japanese, Korean…). */
const isEnter = (e: ReactKeyboardEvent<HTMLElement>) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;

/** Esc in an answer box leaves the box, keeping what's typed; pressed again, it ends the session. */
const leaveOnEsc = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
  if (e.key !== 'Escape' || e.nativeEvent.isComposing) return false;
  e.preventDefault();
  e.currentTarget.blur();
  return true;
};

const CONF: { id: Confidence; label: string }[] = [
  { id: 'guess', label: 'Guessing' },
  { id: 'unsure', label: 'Unsure' },
  { id: 'sure', label: 'Sure' },
];

const GRADES = ['Missed it', 'Partly', 'Got it'];

const md = (s: string) => renderMarkdown(s);

/** Quizlet Learn's feedback lines (from its app strings), rotated so repeats feel human. */
const RIGHT = ['Nice work!', 'Awesome!', 'Excellent!', 'You’re doing great!', 'You’ve got this!'];
const WRONG = ['Not quite, you’re still learning!', 'No worries, learning is a process!'];
const pick = (list: string[], seed: number) => list[Math.abs(Math.floor(seed / 7)) % list.length];

/** Quizlet sizes the prompt by its length: short ones big, long ones smaller. */
const promptSize = (s: string) => (s.length <= 80 ? 'is-l' : s.length <= 200 ? 'is-m' : 'is-s');

/**
 * One question at a time, as Quizlet Learn: a header bar, the progress row with counts at both ends, a tall card
 * with the prompt at the top and the answers at the bottom — then Duolingo's feedback sheet with the note's own
 * words.
 */
export function ReviewSession() {
  const session = useReview((s) => s.session)!;
  const current = useReview((s) => s.current);
  const pool = useReview((s) => s.pool);
  const pastSessions = useReview((s) => s.file.sessions.length);
  const meta = current ? pool.find((p) => p.id === current.concept.id) : undefined;
  const groups = useMemo(() => [...new Set(pool.map((p) => p.groupName))], [pool]);
  const [options, setOptions] = useState(false);
  const [sheet, setSheet] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);

  // Esc leaves the answer box, then ends the session; Enter moves on from feedback; 1–4 pick a choice and 1–3 grade
  // a self-check — when the key is meant for the session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : document.body;
      const r = useReview.getState();
      const k = sessionKey(
        e,
        {
          inSession: t === document.body || t === document.documentElement || !!t.closest('.rv-session'),
          editable: !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'),
          control: !!t.closest('button, a[href], [role="button"], [role="radio"]'),
          overlay: !!document.querySelector('.modal-backdrop, .palette-backdrop, .context-menu'),
        },
        r.current,
      );
      if (!k) return;
      e.preventDefault();
      if (k.do === 'end') r.end();
      else if (k.do === 'blur') (document.activeElement as HTMLElement | null)?.blur();
      else if (k.do === 'next') r.next();
      else if (k.do === 'show') void r.submit('', r.current?.conf ?? null);
      else if (k.do === 'grade') r.selfGrade(k.s);
      else r.choose(k.index, r.current?.conf ?? null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The sheet docks over the bottom of the pane: the stage keeps that much room free below the card, and scrolls
  // the card's answers into view above it.
  const feedback = current?.phase === 'feedback';
  // Each question starts at the top, with the progress row in view.
  useLayoutEffect(() => {
    stage.current?.scrollTo({ top: 0 });
  }, [current?.shownAt]);
  useLayoutEffect(() => {
    const st = stage.current;
    const c = card.current;
    if (!feedback || !st || !c || !sheet) return;
    const over = c.getBoundingClientRect().bottom - (st.getBoundingClientRect().bottom - sheet - 16);
    if (over > 0) st.scrollTop += over;
  }, [feedback, sheet, current?.shownAt]);

  if (!current) return null;
  const section = sectionShown(current.item, factOf(current.item, current.concept)?.key);
  const ask = current.phase === 'ask' || current.phase === 'grading';
  // Quizlet's SHORTCUT tip: the first questions of the first sessions, then it keeps out of the way.
  const tip = pastSessions < 3 && session.index < 3 && (ask || current.phase === 'self');

  return (
    <div className="screen review-view rv-session" style={{ ['--rv-sheet' as string]: `${feedback ? sheet : 0}px` }}>
      <StudyBar title={groups.join(' + ')}>
        <button className="btn is-secondary rv-options-btn" onClick={() => setOptions(true)}>
          Options
        </button>
        <button className="icon-btn rv-close" onClick={() => useReview.getState().end()} title="End the session (Esc)" aria-label="End the session">
          <X size={20} />
        </button>
      </StudyBar>

      <div className="rv-stage" ref={stage}>
        <div className="rv-column">
          <Progress />
          {/* A card per question, so its entrance plays each time. */}
          <div
            ref={card}
            key={current.shownAt}
            className={cx('rv-card', `is-${current.phase}`)}
            style={classStyle(meta?.color)}
            data-concept={current.concept.id}
            data-item-key={current.item.key}
            data-class={meta?.group}
            data-source={current.item.origin}
            data-format={current.item.format}
          >
            <div className="rv-card-head">
              <span className="rv-dot" />
              <span className="rv-where" title={current.item.origin === 'model' ? 'Phrased by your local model, checked against your notes' : 'Built from your notes'}>
                {meta?.groupName ? `${meta.groupName} · ` : ''}
                {current.item.source.title}
                {section ? ` › ${section}` : ''}
              </span>
              <span className="grow" />
              {ask && !current.hintUsed && current.item.format !== 'mcq' && (
                <button
                  className="btn is-ghost is-small rv-hint-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    useReview.getState().showHint();
                    // The button goes once used: typing goes on in the answer box.
                    document.querySelector<HTMLElement>('.rv-card .rv-input')?.focus();
                  }}
                  disabled={current.phase === 'grading'}
                >
                  <Lightbulb size={18} /> Get a hint
                </button>
              )}
            </div>
            <div className={cx('md rv-prompt', promptSize(current.item.prompt))} dangerouslySetInnerHTML={{ __html: md(current.item.prompt) }} />
            {ask && current.hint && <Hint text={current.hint} />}
            {ask && <Ask current={current} askConfidence={session.opts.askConfidence} />}
            {current.phase === 'self' && <SelfGrade current={current} />}
            {current.phase === 'feedback' && <Answered current={current} />}
          </div>
          {tip && <Shortcut current={current} />}
        </div>
      </div>

      {current.phase === 'feedback' && <FeedbackSheet key={current.shownAt} current={current} onHeight={setSheet} />}
      <ReviewOptions open={options} onClose={() => setOptions(false)} classes={groups.length} />
    </div>
  );
}

/** Quizlet's progress row: answered so far in a pill, the track coloured by how each answer went, the length in a pill. */
function Progress() {
  const session = useReview((s) => s.session)!;
  const total = session.opts.length;
  const done = Math.min(session.index, total);
  const right = session.history.filter((h) => h.s >= 0.8).length;
  return (
    <div className="rv-progress-row">
      <span className="rv-pill" aria-hidden>
        {done}
      </span>
      <div className="rv-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} title={`${done} of ${total} answered · ${right} right`}>
        {session.history.slice(0, total).map((h, i) => (
          <span key={i} className={cx('rv-seg', h.s >= 0.8 ? 'is-right' : 'is-missed')} style={{ width: `${100 / total}%` }} />
        ))}
      </div>
      <span className="rv-pill" aria-hidden>
        {total}
      </span>
    </div>
  );
}

function Shortcut({ current }: { current: Current }) {
  const item = current.item;
  const n = item.choices?.length ?? 4;
  return (
    <div className="rv-shortcut">
      <span className="rv-shortcut-icon">
        <Keyboard size={18} />
      </span>
      <span className="rv-shortcut-label">Shortcut</span>
      {current.phase === 'self' ? (
        <span>
          Press <Key>1</Key>, <Key>2</Key> or <Key>3</Key> to say how it went
        </span>
      ) : item.format === 'mcq' ? (
        <span>
          Press <Key>1</Key>–<Key>{n}</Key> to answer
        </span>
      ) : item.format === 'rate' ? (
        <span>
          Press <Key>Enter</Key> to see your notes
        </span>
      ) : (
        <span>
          Press <Key>Enter</Key> to answer
        </span>
      )}
    </div>
  );
}

/** Multiple-choice tiles (Quizlet Learn's numbered answers). After the answer they show how it went. */
function Choices({ current, onChoose, disabled }: { current: Current; onChoose?(i: number): void; disabled?: boolean }) {
  const item = current.item;
  const choices = item.choices ?? [];
  const done = current.phase === 'feedback';
  // Long options or display maths read better one per row.
  const single = choices.some((c) => c.length > 60 || c.includes('$$'));
  return (
    <div className={cx('rv-choices', single && 'is-single', done && 'is-done')}>
      {choices.map((c, i) => {
        const chosen = done && current.choice === i;
        const correct = done && i === item.correct;
        const state = chosen ? (correct ? 'is-right' : 'is-wrong') : correct ? 'is-answer' : done ? 'is-dim' : undefined;
        return (
          <button key={i} className={cx('rv-choice', state)} onClick={() => onChoose?.(i)} disabled={disabled || done}>
            <span className="rv-choice-n">{correct ? <Check size={18} strokeWidth={2.5} /> : chosen ? <X size={18} strokeWidth={2.5} /> : i + 1}</span>
            <span className="md" dangerouslySetInnerHTML={{ __html: md(c) }} />
          </button>
        );
      })}
    </div>
  );
}

function Ask({ current, askConfidence }: { current: Current; askConfidence: boolean }) {
  const [text, setText] = useState('');
  // Kept with the question, so answering a choice with the 1–4 keys keeps it too.
  const conf = current.conf ?? null;
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const item = current.item;
  const grading = current.phase === 'grading';
  useEffect(() => {
    setText('');
    ref.current?.focus();
  }, [item.key, current.shownAt]);

  const submit = () => {
    if (grading) return;
    if (item.format === 'rate') {
      void useReview.getState().submit('', conf);
      return;
    }
    if (!text.trim()) return;
    void useReview.getState().submit(text, conf);
  };
  const long = item.format === 'explain' || item.format === 'apply' || item.format === 'connect';
  const idk = (
    <button className="btn is-ghost rv-idk" onClick={() => useReview.getState().dontKnow()} disabled={grading}>
      Don’t know?
    </button>
  );

  return (
    <div className="rv-ask">
      <div className="rv-answer-head">
        <span className="rv-answer-label">{item.format === 'mcq' ? 'Choose the answer' : item.format === 'rate' ? 'Answer in your head (or on paper), then check it against your notes' : 'Your answer'}</span>
        {/* Clicking a segment keeps the answer box focused, so Enter still checks and typing goes on. */}
        {askConfidence && (
          <div className="seg rv-conf" role="radiogroup" aria-label="How sure are you?">
            {CONF.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={conf === c.id}
                className={cx(conf === c.id && 'is-active')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => useReview.getState().setConf(conf === c.id ? null : c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {item.format === 'mcq' ? (
        <>
          <Choices current={current} onChoose={(i) => useReview.getState().choose(i, conf)} disabled={grading} />
          <div className="rv-ask-actions">{idk}</div>
        </>
      ) : (
        <>
          {item.format !== 'rate' &&
            (long ? (
              <textarea
                ref={ref}
                className="rv-input is-long"
                rows={3}
                placeholder="Type the answer in your own words"
                value={text}
                disabled={grading}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (leaveOnEsc(e)) return;
                  if (isEnter(e) && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            ) : (
              <input
                ref={ref}
                className="rv-input"
                placeholder="Type the answer"
                value={text}
                disabled={grading}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (leaveOnEsc(e)) return;
                  if (isEnter(e)) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            ))}
          <div className="rv-ask-actions">
            {grading && <span className="rv-grading">Just a sec! Checking your notes.</span>}
            <span className="grow" />
            {idk}
            <button className="btn is-primary rv-check-btn" onClick={submit} disabled={grading || (item.format !== 'rate' && !text.trim())}>
              {grading ? (
                <>
                  <span className="rv-spinner" /> Checking…
                </>
              ) : item.format === 'rate' ? (
                'Show my notes'
              ) : (
                'Answer'
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** After the answer, the card keeps it in place — the tiles marked, or the written answer in the verdict's colour. */
function Answered({ current }: { current: Current }) {
  const fb = current.feedback!;
  const item = current.item;
  if (item.format === 'mcq')
    return (
      <div className="rv-ask">
        <div className="rv-answer-head">
          <span className="rv-answer-label">{current.dontKnow ? 'The answer' : 'Your answer'}</span>
        </div>
        <Choices current={current} />
      </div>
    );
  if (item.format === 'rate') {
    const chosen = SELF_GRADES.indexOf(fb.s);
    return (
      <div className="rv-self-result">
        <div className="rv-answer-head">
          <span className="rv-answer-label">How you did</span>
        </div>
        <div className="rv-grades is-done">
          {GRADES.map((label, i) => (
            <button key={label} className={cx('rv-grade', i === chosen ? `is-chosen is-${fb.verdict}` : 'is-dim')} disabled>
              <span className="rv-choice-n">{i + 1}</span> {label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (canRetryOf(current)) return <RetryBox />;
  const retry = current.retry;
  const shown = retry ? retry.answer : current.answer;
  if (current.dontKnow || !shown?.trim()) return null;
  const tone = retry ? (retry.checking || retry.s === undefined ? 'is-plain' : retry.s >= 0.8 ? 'is-right' : 'is-wrong') : `is-${fb.verdict}`;
  return (
    <div className="rv-ask">
      <div className="rv-answer-head">
        <span className="rv-answer-label">{retry ? 'Your second try' : 'Your answer'}</span>
      </div>
      <div className={cx('rv-answered', tone)}>{shown}</div>
    </div>
  );
}

const canRetryOf = (cur: Current) =>
  cur.feedback!.verdict !== 'right' && !cur.dontKnow && !cur.revealed && !cur.retry && cur.item.format !== 'mcq' && cur.item.format !== 'rate';

/** A miss on a written answer: the card's box opens again for one more try (Enter on an empty box moves on). */
function RetryBox() {
  const [again, setAgain] = useState('');
  return (
    <div className="rv-ask rv-retry">
      <div className="rv-answer-head">
        <span className="rv-answer-label">Your answer</span>
      </div>
      <input
        className="rv-input"
        placeholder="Try once more"
        value={again}
        autoFocus
        onChange={(e) => setAgain(e.target.value)}
        onKeyDown={(e) => {
          if (leaveOnEsc(e) || !isEnter(e)) return;
          e.preventDefault();
          if (again.trim()) void useReview.getState().retry(again);
          else useReview.getState().next();
        }}
      />
      <div className="rv-ask-actions">
        <span className="grow" />
        <button className="btn is-primary rv-check-btn" disabled={!again.trim()} onClick={() => void useReview.getState().retry(again)}>
          Answer
        </button>
      </div>
    </div>
  );
}

/** The idea's mastery: shown where it was, then moved to where it is now (so the change is seen). */
function MasteryBar({ before, after }: { before: number; after: number }) {
  const [width, setWidth] = useState(before);
  useEffect(() => {
    // Waits a moment after the sheet slides up, so the move is seen rather than skipped.
    const id = window.setTimeout(() => setWidth(after), 200);
    return () => window.clearTimeout(id);
  }, [after]);
  return (
    <span className="rv-bar">
      <span style={{ width: `${width}%` }} />
    </span>
  );
}

/** A hint quotes the notes, math and all. */
function Hint({ text }: { text: string }) {
  return (
    <div className="rv-hint">
      <Lightbulb size={18} />
      <span className="md is-inline" dangerouslySetInnerHTML={{ __html: md(text).trim() }} />
    </div>
  );
}

/** The notes' own words, with the part of the note they come from (it opens there). */
function NotesSay({ current, label = 'Your notes say', points }: { current: Current; label?: string; points?: string[] }) {
  const src = current.item.source;
  return (
    <div className="rv-notes-say">
      <div className="rv-notes-say-head">
        <span>{label}</span>
        <button
          className="rv-source-chip"
          onClick={() => useUI.getState().openNote(src.noteId, { newTab: true, blockId: src.blockId ?? undefined })}
          title="Open this part of your notes"
        >
          <span>
            {src.title}
            {src.section ? ` › ${src.section}` : ''}
          </span>
          <ExternalLink size={14} />
        </button>
      </div>
      {points?.length ? (
        <ul className="rv-points">
          {points.map((p, i) => (
            <li key={i} className="md" dangerouslySetInnerHTML={{ __html: md(p) }} />
          ))}
        </ul>
      ) : (
        <div className="md rv-notes-say-text" dangerouslySetInnerHTML={{ __html: md(current.item.fact) }} />
      )}
    </div>
  );
}

/** A line without its markdown, for comparing. */
const plain = (s: string) =>
  s
    .replace(/\*\*|==|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A self-check: the notes' answer, then Quizlet's numbered "how did you do" tiles (Anki's grade buttons). */
function SelfGrade({ current }: { current: Current }) {
  // The points besides the line "Your notes say" already shows.
  const points = (current.item.points ?? []).filter((p) => plain(p) !== plain(current.item.fact));
  return (
    <div className="rv-self">
      {current.answer?.trim() && (
        <div className="rv-ask">
          <div className="rv-answer-head">
            <span className="rv-answer-label">Your answer</span>
          </div>
          <div className="rv-answered is-plain">{current.answer}</div>
        </div>
      )}
      <NotesSay current={current} />
      {points.length > 0 && (
        <ul className="rv-points">
          {points.map((p, i) => (
            <li key={i} className="md" dangerouslySetInnerHTML={{ __html: md(p) }} />
          ))}
        </ul>
      )}
      <div className="rv-answer-head">
        <span className="rv-answer-label">How did you do?</span>
      </div>
      <div className="rv-grades">
        {GRADES.map((label, i) => (
          <button key={label} className="rv-grade" onClick={() => useReview.getState().selfGrade(SELF_GRADES[i])}>
            <span className="rv-choice-n">{i + 1}</span> {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Duolingo's feedback sheet: docked to the bottom of the pane in the verdict's colour, a white circle with the
 * mark, the title and small links in that colour, Continue at the right. The note's own words sit in it.
 */
function FeedbackSheet({ current, onHeight }: { current: Current; onHeight(h: number): void }) {
  const fb = current.feedback!;
  const overrides = useReview((s) => s.overrides);
  const missedBefore = useReview((s) => (s.current ? (s.current.sessBefore?.misses[s.current.concept.id] ?? 0) : 0));
  const ref = useRef<HTMLElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const wrong = fb.verdict !== 'right';
  // "I don't know" is no mistake: it gets the answer, in "still learning" orange rather than red.
  const idk = !!current.dontKnow;
  const canRetry = canRetryOf(current);
  const retry = current.retry;
  const tone = idk || fb.verdict === 'partial' ? 'learning' : fb.verdict;
  const title = idk
    ? 'Give this one a try later!'
    : current.overridden
      ? 'Counted as right'
      : fb.verdict === 'right'
        ? missedBefore > 0
          ? 'Amazing, you got it this time!'
          : pick(RIGHT, current.shownAt)
        : fb.verdict === 'partial'
          ? 'No sweat, you’re still learning!'
          : pick(WRONG, current.shownAt);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    onHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [onHeight]);
  // Continue takes the focus (Enter moves on) — unless the answer box is open for another try.
  useEffect(() => {
    if (!canRetry) next.current?.focus({ preventScroll: true });
  }, [canRetry]);

  const report = () => {
    const key = current.item.key;
    useReview.getState().report();
    toast.info('Question reported — you won’t see it again', undefined, { label: 'Undo', run: () => useReview.getState().unreport(key) });
  };
  const explain = () => {
    const src = current.item.source;
    const note = useVault.getState().notes[src.noteId];
    useUI.getState().set({ view: { kind: 'library' }, libraryScope: { kind: 'note', id: src.noteId } });
    void useAssistant.getState().askLibrary({
      prompt: `Why is this so: ${current.item.fact.replace(/\*\*|==/g, '')}`,
      scope: { kind: 'note', id: src.noteId },
      scopeLabel: note?.meta.title,
    });
  };
  const adds = fb.verdict === 'partial' ? (fb.missed ?? []) : [];

  return (
    <section ref={ref} className={cx('rv-feedback', `is-${tone}`)} aria-live="polite">
      <div className="rv-sheet">
        <span className="rv-sheet-icon" aria-hidden>
          {idk || fb.verdict === 'partial' ? <BookOpen size={28} strokeWidth={2.5} /> : fb.verdict === 'right' ? <Check size={32} strokeWidth={3} /> : <X size={32} strokeWidth={3} />}
        </span>
        <div className="rv-sheet-body">
          <div className={cx('rv-verdict', `is-${fb.verdict}`, idk && 'is-idk')}>{title}</div>
          {fb.note && <div className="rv-grade-note">{fb.note}</div>}
          {fb.hypercorrect && <div className="rv-hyper">You were sure about this one — confident mix-ups are the easiest to fix now.</div>}
          {fb.lucky && <div className="rv-hyper">Right — but you were guessing.</div>}

          {canRetry && (
            <div className="rv-retry-note">
              {current.hint && <Hint text={current.hint} />}
              <div>
                Try once more — or{' '}
                <button className="rv-link rv-show" onClick={() => useReview.getState().reveal()}>
                  Show the answer
                </button>
              </div>
            </div>
          )}
          {/* Once counted as right, the second try's verdict is beside the point. */}
          {current.overridden ? null : retry?.checking ? (
            <div className="rv-grading">
              <span className="rv-spinner" /> Just a sec! Checking your notes.
            </div>
          ) : retry && retry.s === undefined ? (
            <div className="rv-retry-result">Compare it with what your notes say.</div>
          ) : retry && retry.s !== undefined ? (
            <div className={cx('rv-retry-result', retry.s >= 0.8 ? 'is-right' : 'is-wrong')}>{retry.s >= 0.8 ? 'Got it on the second try.' : 'Not yet — here’s what your notes say.'}</div>
          ) : null}

          {(current.revealed || (!canRetry && !retry?.checking)) && <NotesSay current={current} label={adds.length ? 'What your notes add' : 'Your notes say'} points={adds} />}

          <div className="rv-sheet-foot">
            <div className="rv-links">
              <button className="rv-link" onClick={explain} title="Ask your notes why — answered only from your notes">
                <MessageCircleQuestion size={16} /> Explain this answer
              </button>
              {/* Counted, the link keeps its place, so Report doesn't slide under the pointer. */}
              {current.overridden ? (
                <button className="rv-link" disabled>
                  <Check size={16} /> Counted
                </button>
              ) : (
                wrong &&
                canOverride(current) &&
                overrides < 3 && (
                  <button className="rv-link" onClick={() => useReview.getState().override()} title="Count it as right (at most 3 times a session)">
                    <Check size={16} /> Override: I was correct
                  </button>
                )
              )}
              <button className="rv-link" onClick={report} title="This question is wrong or unclear — skip it and don’t ask it again">
                <Flag size={16} /> Report
              </button>
            </div>
            <div className="rv-mastery-change" title="How well you know this idea">
              <span className="rv-mastery-name">{current.concept.name.replace(/\*\*/g, '')}</span>
              <MasteryBar before={fb.before} after={fb.after} />
              <span className="rv-pct">
                {fb.before}% → {fb.after}%
              </span>
              {fb.mastered && <span className="rv-badge">Mastered</span>}
            </div>
          </div>
        </div>
        <div className="rv-sheet-action">
          <button ref={next} className="btn rv-next" onClick={() => useReview.getState().next()} disabled={!!retry?.checking}>
            Continue
          </button>
        </div>
      </div>
    </section>
  );
}
