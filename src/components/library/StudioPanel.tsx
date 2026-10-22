import { useState } from 'react';
import {
  BookOpenText,
  ChevronRight,
  Download,
  FileQuestion,
  GalleryVerticalEnd,
  MoreVertical,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  ScrollText,
  Shuffle,
  Table2,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatMsg, SourceRef } from '../../state/assistant';
import type { StudyTool } from '../../lib/ai/prompts';
import { Modal } from '../common/Modal';
import { Popover } from '../common/Popover';
import { MessageView } from '../ai/Message';
import { openSource } from '../ai/Citations';
import { Flashcards, Quiz, parseStudyJSON, type QuizQ } from './StudyTools';
import { TOOL_LOOK } from './notebook';
import { cx, formatRelativeTime, plural } from '../../lib/util';

export const TOOL_ICON: Record<StudyTool | 'review', typeof Target> = {
  guide: BookOpenText,
  summary: ScrollText,
  terms: Table2,
  flashcards: GalleryVerticalEnd,
  quiz: FileQuestion,
  review: Target,
};

const TILES: (StudyTool | 'review')[] = ['guide', 'summary', 'terms', 'flashcards', 'quiz', 'review'];
/** Tools with options get NotebookLM's pencil. */
const CUSTOMIZABLE = new Set<StudyTool | 'review'>(['guide', 'flashcards', 'quiz']);

/** A study tool's result, as the Studio lists it (made from the chat thread's tool replies). */
export interface Output {
  msg: ChatMsg;
  tool: StudyTool;
  title: string;
  notes: number;
  busy: boolean;
  failed: boolean;
  parsed: ReturnType<typeof parseStudyJSON>;
}

export function toolStyle(tool: StudyTool | 'review') {
  const t = TOOL_LOOK[tool];
  return { ['--tool-bg' as string]: t.bg, ['--tool-ink' as string]: t.ink };
}

export function ToolIcon({ tool, size = 18 }: { tool: StudyTool | 'review'; size?: number }) {
  const I = TOOL_ICON[tool];
  return <I size={size} />;
}

function outputMeta(o: Output): string {
  if (o.busy) return `from ${plural(o.notes || 1, 'note')} · this can take a minute`;
  if (o.failed) return 'Didn’t work · open to see why';
  const when = formatRelativeTime(o.msg.at);
  return `${plural(o.notes, 'note')} · ${when === 'Just now' ? 'just now' : when}`;
}

export function StudioPanel({
  outputs,
  busy,
  canRun,
  rail,
  onToggle,
  onRun,
  onReview,
  opened,
  onOpen,
  onDelete,
  onSave,
}: {
  outputs: Output[];
  /** A reply is streaming: the model does one thing at a time. */
  busy: boolean;
  canRun: boolean;
  rail: boolean;
  onToggle(): void;
  onRun(tool: StudyTool, topic?: string): void;
  onReview(): void;
  opened: Set<string>;
  onOpen(id: string): void;
  onDelete(id: string): void;
  onSave(o: Output): void;
}) {
  const [custom, setCustom] = useState<StudyTool | null>(null);
  const [menu, setMenu] = useState<{ el: HTMLElement; o: Output } | null>(null);
  const run = (t: StudyTool | 'review') => (t === 'review' ? onReview() : onRun(t));
  const why = !canRun ? 'Tick at least one note in Sources' : busy ? 'Wait for the current answer to finish' : undefined;

  if (rail) {
    return (
      <aside className="lib-panel lib-studio is-rail" aria-label="Studio">
        <div className="lib-panel-head">
          <button className="icon-btn" onClick={onToggle} title="Show Studio" aria-label="Show Studio">
            <PanelRightOpen size={20} />
          </button>
        </div>
        <div className="lib-rail-list">
          {TILES.map((t) => (
            <button
              key={t}
              className="icon-btn studio-rail-tool"
              style={toolStyle(t)}
              title={why && t !== 'review' ? why : TOOL_LOOK[t].name}
              aria-label={TOOL_LOOK[t].name}
              disabled={t !== 'review' && (busy || !canRun)}
              onClick={() => run(t)}
            >
              <ToolIcon tool={t} size={20} />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="lib-panel lib-studio" aria-label="Studio">
      <div className="lib-panel-head">
        <span className="lib-panel-title">Studio</span>
        <button className="icon-btn" onClick={onToggle} title="Hide Studio" aria-label="Hide Studio">
          <PanelRightClose size={20} />
        </button>
      </div>
      <div className="studio-body">
        <div className="studio-tiles">
          {TILES.map((t) => {
            const off = t !== 'review' && (busy || !canRun);
            return (
              <div key={t} className={cx('studio-tile', off && 'is-off')} style={toolStyle(t)}>
                <button
                  className="study-tool"
                  disabled={off}
                  title={off ? why : t === 'review' ? 'Review the ticked notes with questions' : undefined}
                  onClick={() => run(t)}
                >
                  <ToolIcon tool={t} />
                  <span className="study-tool-name">{TOOL_LOOK[t].name}</span>
                </button>
                {CUSTOMIZABLE.has(t) && (
                  <button className="studio-tile-edit" disabled={off} title={`Customize ${TOOL_LOOK[t].noun}`} aria-label={`Customize ${TOOL_LOOK[t].noun}`} onClick={() => setCustom(t as StudyTool)}>
                    <Pencil size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="studio-divider" />
        {outputs.length === 0 ? (
          <div className="studio-empty">
            <div className="studio-empty-title">Study tools you make will be saved here</div>
            <div className="studio-empty-sub">Pick a tool above. Every card and question comes from the notes you’ve ticked.</div>
          </div>
        ) : (
          <div className="studio-list">
            {outputs.map((o) => (
              <div
                key={o.msg.id}
                className={cx('studio-row', o.busy && 'is-busy')}
                style={toolStyle(o.tool)}
                role="button"
                tabIndex={0}
                onClick={() => !o.busy && onOpen(o.msg.id)}
                onKeyDown={(e) => e.key === 'Enter' && !o.busy && onOpen(o.msg.id)}
              >
                <span className="studio-row-icon">{o.busy ? <span className="spinner" /> : <ToolIcon tool={o.tool} size={22} />}</span>
                <span className="studio-row-text">
                  <span className="studio-row-title">{o.busy ? `Generating ${TOOL_LOOK[o.tool].noun}…` : o.title}</span>
                  <span className="studio-row-meta">{outputMeta(o)}</span>
                </span>
                {!o.busy && !o.failed && !opened.has(o.msg.id) && <span className="studio-new" aria-label="New" />}
                <button
                  className="icon-btn studio-row-more"
                  aria-label="More"
                  title="More"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu({ el: e.currentTarget, o });
                  }}
                >
                  <MoreVertical size={20} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <Popover anchor={menu?.el ?? null} open={!!menu} onClose={() => setMenu(null)} align="end" className="menu-pop">
        {menu && (
          <div className="menu">
            {!menu.o.busy && !menu.o.failed && (
              <button className="menu-item" onClick={() => (setMenu(null), onSave(menu.o))}>
                <Download size={20} />
                <span className="menu-label">Save as note</span>
              </button>
            )}
            <button className="menu-item" onClick={() => (setMenu(null), onDelete(menu.o.msg.id))}>
              <Trash2 size={20} />
              <span className="menu-label">Delete</span>
            </button>
          </div>
        )}
      </Popover>
      <CustomizeDialog tool={custom} onClose={() => setCustom(null)} onGenerate={(t, topic) => (setCustom(null), onRun(t, topic))} />
    </aside>
  );
}

/** NotebookLM's pencil dialog: what to focus on, then Generate. */
function CustomizeDialog({ tool, onClose, onGenerate }: { tool: StudyTool | null; onClose(): void; onGenerate(t: StudyTool, topic: string): void }) {
  const [topic, setTopic] = useState('');
  if (!tool) return null;
  const look = TOOL_LOOK[tool];
  const go = () => {
    onGenerate(tool, topic.trim());
    setTopic('');
  };
  return (
    <Modal open onClose={onClose} width={560} bare className="lib-dialog">
      <div className="lib-dialog-head">
        <span className="lib-dialog-icon" style={toolStyle(tool)}>
          <ToolIcon tool={tool} size={20} />
        </span>
        <span className="lib-dialog-title">Customize {look.noun}</span>
        <button className="lib-dialog-close" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </div>
      <div className="lib-dialog-body">
        <label className="lib-dialog-label" htmlFor="studio-topic">
          What should the {look.noun} focus on?
        </label>
        <textarea
          id="studio-topic"
          autoFocus
          className="lib-dialog-text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go();
          }}
          placeholder={'Things to try\n• One topic from your notes (“the squeeze theorem”)\n• Only the formulas, or only the definitions'}
        />
        <div className="lib-dialog-hint">Leave it empty to cover every note you’ve ticked. Everything still comes only from your notes.</div>
      </div>
      <div className="lib-dialog-foot">
        <button className="btn is-primary" onClick={go}>
          Generate
        </button>
      </div>
    </Modal>
  );
}

/** An output opened in Studio (breadcrumb "Studio › Flashcards"), taking the room the chat had. */
export function ArtifactView({
  output,
  isLast,
  onClose,
  onCite,
  citeHover,
  onExplain,
  onSave,
  onRetry,
}: {
  output: Output;
  isLast: boolean;
  onClose(): void;
  onCite(n: number, el: HTMLElement, sources: SourceRef[] | undefined): void;
  citeHover(sources: SourceRef[] | undefined): React.HTMLAttributes<HTMLDivElement>;
  onExplain(prompt: string): void;
  onSave(o: Output): void;
  onRetry(): void;
}) {
  const [order, setOrder] = useState(0);
  const { msg, tool, parsed } = output;
  const sources = msg.sources ?? [];
  const json = tool === 'flashcards' || tool === 'quiz';
  const skipped = msg.dropped && parsed ? ` · ${plural(msg.dropped, tool === 'quiz' ? 'question' : tool === 'flashcards' ? 'card' : 'item')} skipped: not in your notes` : '';
  return (
    <section className="lib-panel lib-studio is-artifact studio-artifact" aria-label={`Studio, ${TOOL_LOOK[tool].name}`}>
      <div className="lib-panel-head">
        <nav className="art-crumbs" aria-label="Breadcrumb">
          <button className="art-crumb" onClick={onClose}>
            Studio
          </button>
          <ChevronRight size={18} className="art-crumb-sep" />
          <span className="art-crumb is-current">{TOOL_LOOK[tool].name}</span>
        </nav>
        <span className="grow" />
        {parsed?.kind === 'flashcards' && (
          <button className="icon-btn" title="Shuffle" aria-label="Shuffle" onClick={() => setOrder((v) => v + 1)}>
            <Shuffle size={20} />
          </button>
        )}
        {(parsed || (msg.status === 'done' && !output.failed)) && (
          <button className="icon-btn" title="Save as note" aria-label="Save as note" onClick={() => onSave(output)}>
            <Download size={20} />
          </button>
        )}
        <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="art-body">
        <div className="art-column">
          <div className="art-title">{output.title}</div>
          <div className="art-sub">
            Based on {plural(output.notes, 'note')}
            {skipped}
          </div>
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
                <div className="msg-added">None of what the model wrote could be matched to your notes, so nothing is shown. Try again, or pick a larger model in Settings → Local AI.</div>
              ) : (
                <MessageView
                  // Half-written cards or questions are JSON: a stopped one shows just "Stopped".
                  msg={json && msg.status === 'stopped' ? { ...msg, content: '' } : msg}
                  citations
                  onCite={(n, el) => onCite(n, el, sources)}
                  onRegenerate={isLast ? onRetry : undefined}
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
