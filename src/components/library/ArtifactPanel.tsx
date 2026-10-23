import { useState } from 'react';
import { BookA, BookOpenText, Check, Copy, FilePlus2, FileQuestion, GalleryVerticalEnd, ScrollText, Shuffle, Target, X } from 'lucide-react';
import type { ChatMsg, SourceRef } from '../../state/assistant';
import type { StudyTool } from '../../lib/ai/prompts';
import { copyText, MessageView } from '../ai/Message';
import { openSource } from '../ai/Citations';
import { Flashcards, Quiz, parseStudyJSON, type QuizQ } from './StudyTools';
import { TOOL_LOOK } from './notebook';
import { cx, plural } from '../../lib/util';

export const TOOL_ICON: Record<StudyTool | 'review', typeof Target> = {
  summary: ScrollText,
  guide: BookOpenText,
  terms: BookA,
  flashcards: GalleryVerticalEnd,
  quiz: FileQuestion,
  review: Target,
};

export function ToolIcon({ tool, size = 16 }: { tool: StudyTool | 'review'; size?: number }) {
  const I = TOOL_ICON[tool];
  return <I size={size} />;
}

export function toolStyle(tool: StudyTool | 'review') {
  const t = TOOL_LOOK[tool];
  return { ['--tool-bg' as string]: t.bg, ['--tool-ink' as string]: t.ink };
}

/** A study tool's result (made from a tool reply in the conversation). */
export interface Output {
  msg: ChatMsg;
  tool: StudyTool;
  title: string;
  notes: number;
  busy: boolean;
  failed: boolean;
  parsed: ReturnType<typeof parseStudyJSON>;
}

/** "12 cards", "5 questions", or how many notes a prose output came from. */
export function outputMeta(o: Output): string {
  if (o.parsed?.kind === 'flashcards') return plural(o.parsed.cards.length, 'card');
  if (o.parsed?.kind === 'quiz') return plural(o.parsed.questions.length, 'question');
  return `From ${plural(o.notes || 1, 'note')}`;
}

/** Cards or questions dropped because no passage of the notes backed them: said wherever the output's size is. */
export function LeftOut({ output }: { output: Output }) {
  const { msg, tool, parsed } = output;
  if (!msg.dropped || !parsed) return null;
  return (
    <span className="art-left-out" title="No passage of your notes backed them">
      {' '}
      · {plural(msg.dropped, tool === 'quiz' ? 'question' : 'card')} left out: not in your notes
    </span>
  );
}

/**
 * A study output opened beside the conversation, as Claude opens an artifact: its name and kind in the
 * header with Shuffle / Copy, Save as note and Close; the cards, quiz or text below. (Retry stays with
 * its card in the conversation.)
 */
export function ArtifactPanel({
  output,
  overlay,
  onClose,
  onCite,
  citeHover,
  onExplain,
  onSave,
}: {
  output: Output;
  /** The page is too narrow to share: the panel floats over the conversation. */
  overlay: boolean;
  onClose(): void;
  onCite(n: number, el: HTMLElement, sources: SourceRef[] | undefined): void;
  citeHover(sources: SourceRef[] | undefined): React.HTMLAttributes<HTMLDivElement>;
  onExplain(prompt: string): void;
  onSave(o: Output): void;
}) {
  const [order, setOrder] = useState(0);
  const [copied, setCopied] = useState(false);
  const { msg, tool, parsed } = output;
  const sources = msg.sources ?? [];
  const json = tool === 'flashcards' || tool === 'quiz';
  const ready = !!parsed || (msg.status === 'done' && !output.failed);
  return (
    <section className={cx('lib-artifact', overlay && 'is-overlay')} aria-label={output.title}>
      <header className="art-head">
        <span className="art-icon">
          <ToolIcon tool={tool} />
        </span>
        <div className="art-heading">
          <div className="art-title" title={output.title}>
            {output.title}
          </div>
          <div className="art-sub">
            {outputMeta(output)}
            <LeftOut output={output} />
          </div>
        </div>
        {parsed?.kind === 'flashcards' && (
          <button className="icon-btn is-tiny" title="Shuffle" aria-label="Shuffle" onClick={() => setOrder((v) => v + 1)}>
            <Shuffle size={16} />
          </button>
        )}
        {!json && ready && (
          <button
            className="icon-btn is-tiny"
            title={copied ? 'Copied' : 'Copy'}
            aria-label="Copy"
            onClick={() => {
              navigator.clipboard?.writeText(copyText(msg)).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        )}
        {ready && (
          <button className="icon-btn is-tiny" title="Save as note" aria-label="Save as note" onClick={() => onSave(output)}>
            <FilePlus2 size={16} />
          </button>
        )}
        <button className="icon-btn is-tiny" title="Close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="art-body">
        <div className="art-column">
          {parsed?.kind === 'flashcards' && (
            <Flashcards cards={parsed.cards} sources={sources} order={order} onOpen={openSource} onExplain={(front) => onExplain(`Explain: ${front}`)} />
          )}
          {parsed?.kind === 'quiz' && (
            <Quiz
              questions={parsed.questions}
              sources={sources}
              onOpen={openSource}
              onExplain={(q: QuizQ, picked) =>
                onExplain(
                  picked !== null && picked !== q.answer
                    ? `Explain why the answer to “${q.q}” is “${q.choices[q.answer]}”, not “${q.choices[picked]}”.`
                    : `Explain why the answer to “${q.q}” is “${q.choices[q.answer]}”.`,
                )
              }
            />
          )}
          {!parsed && (
            <div className="art-prose" {...citeHover(sources)}>
              {json && msg.status === 'done' && msg.dropped ? (
                <div className="msg-added">
                  None of what the model wrote could be matched to your notes, so nothing is shown. Try again, or pick a larger model in Settings → Local AI.
                </div>
              ) : (
                <MessageView
                  // Half-written cards or questions are JSON: a stopped one shows just "Stopped".
                  msg={json && msg.status === 'stopped' ? { ...msg, content: '' } : msg}
                  citations
                  onCite={(n, el) => onCite(n, el, sources)}
                  iconActions
                />
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
