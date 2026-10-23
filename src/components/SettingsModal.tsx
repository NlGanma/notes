import { useEffect, useLayoutEffect, useState } from 'react';
import { Check, Copy, Cpu, FolderOpen, Info, Keyboard, Loader2, PenLine, RefreshCw, Radar, Settings2, X } from 'lucide-react';
import { Modal } from './common/Modal';
import { useUI, type SettingsSection } from '../state/ui';
import { useAI } from '../state/ai';
import { useSettings, type FontChoice, type LineSpacing, type PageSize } from '../state/settings';
import { useTools } from '../state/tools';
import { useVault } from '../state/vault';
import { DEFAULT_URLS, type ModelInfo } from '../lib/ai/providers';
import { bridge, isElectron, MOD, SHIFT, ALT } from '../lib/platform';
import { openVaultFolder } from '../lib/commands';
import { cx, formatRelativeTime } from '../lib/util';
import { chatRobust, useActivity } from '../lib/ai/engine';
import { NibMark } from './common/NibMark';
import { importFiles } from '../lib/import';

const ICON = { size: 16, strokeWidth: 1.5 };

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { id: 'general', label: 'General', icon: <Settings2 {...ICON} /> },
  { id: 'writing', label: 'Writing & paper', icon: <PenLine {...ICON} /> },
  { id: 'ai', label: 'Local AI', icon: <Cpu {...ICON} /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard {...ICON} /> },
  { id: 'about', label: 'About', icon: <Info {...ICON} /> },
];

export function SettingsModal() {
  const section = useUI((s) => s.settings);
  const close = () => useUI.getState().openSettings(null);
  const [scrolled, setScrolled] = useState(false);
  // Each pane opens at its top (the body is keyed by pane), so the header's hairline starts off.
  useLayoutEffect(() => setScrolled(false), [section]);
  return (
    <Modal open={!!section} onClose={close} width={880} bare className="settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings">
          <h1 className="settings-nav-title">Settings</h1>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={cx('settings-nav-item', section === s.id && 'is-active')}
              aria-current={section === s.id ? 'page' : undefined}
              onClick={() => useUI.getState().openSettings(s.id)}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          {/* The pane's name and the close button stay put; only the rows under them scroll. */}
          <div className={cx('settings-head', scrolled && 'is-scrolled')}>
            <h2>{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <button className="icon-btn is-tiny settings-close" onClick={close} aria-label="Close">
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>
          <div className="settings-body" key={section} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}>
            {section === 'general' && <GeneralSection />}
            {section === 'ai' && <AISection />}
            {section === 'writing' && <WritingSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** A setting: its name and a line of help on the left, its control on the right (or under it, `stacked`). */
function Row({ title, help, children, stacked }: { title: React.ReactNode; help?: React.ReactNode; children?: React.ReactNode; stacked?: boolean }) {
  return (
    <div className={cx('set-row', stacked && 'is-stacked')}>
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {help && <div className="set-row-help">{help}</div>}
      </div>
      {children && <div className="set-row-control">{children}</div>}
    </div>
  );
}

/** A switch on a settings row: the row's name is its label. */
function SwitchRow({ title, help, checked, onChange }: { title: string; help?: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="set-row is-switch">
      <span className="set-row-text">
        <span className="set-row-title">{title}</span>
        {help && <span className="set-row-help">{help}</span>}
      </span>
      <span className={cx('switch', checked && 'is-on')}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
    </label>
  );
}

/** A segmented control: the chosen item sits on a white thumb. */
function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} role="radio" aria-checked={value === v} className={cx(value === v && 'is-active')} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function modelLabel(m: ModelInfo) {
  // ":latest" is the tag a model gets when none is named; it only crowds the menu.
  const parts = [m.name.replace(/:latest$/, '')];
  if (m.params) parts.push(m.params);
  return parts.join(' · ');
}

/** What a picked model can do, for the row's help line (the menu itself only names the models). */
function modelNote(value: string, models: ModelInfo[]) {
  if (!value) return '';
  const m = models.find((m) => m.name === value);
  if (!m) return models.length ? ` ${value} isn’t on the server.` : '';
  return [m.vision && ' Sees images.', m.thinking && ' Reasons before answering.'].filter(Boolean).join('');
}

function ModelSelect({
  value,
  onChange,
  models,
  filter,
  none,
}: {
  value: string;
  onChange(v: string): void;
  models: ModelInfo[];
  filter(m: ModelInfo): boolean;
  none?: string;
}) {
  const list = models.filter(filter);
  const known = list.some((m) => m.name === value);
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {none !== undefined && <option value="">{none}</option>}
      {!known && value && <option value={value}>{value}</option>}
      {list.map((m) => (
        <option key={m.name} value={m.name}>
          {modelLabel(m)}
        </option>
      ))}
    </select>
  );
}

function CopyCmd({ cmd, note }: { cmd: string; note: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="cmd">
      <code>{cmd}</code>
      <span className="cmd-note">{note}</span>
      <button
        className="icon-btn is-tiny"
        onClick={() => {
          navigator.clipboard?.writeText(cmd).catch(() => undefined);
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        }}
        aria-label="Copy"
      >
        {ok ? <Check {...ICON} /> : <Copy {...ICON} />}
      </button>
    </div>
  );
}

function AISection() {
  const ai = useAI();
  const [url, setUrl] = useState(ai.baseUrl);
  const [detecting, setDetecting] = useState(false);
  useEffect(() => setUrl(ai.baseUrl), [ai.baseUrl]);
  useEffect(() => {
    if (ai.status === 'unknown') void ai.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chatModels = ai.models.filter((m) => !m.embedding);
  const chatInfo = ai.models.find((m) => m.name === ai.chatModel);
  const vision = ai.visionModel || (chatInfo?.vision ? ai.chatModel : '');
  const statusText =
    ai.status === 'online'
      ? `Running${ai.serverLabel ? ` on ${ai.serverLabel}` : ''}`
      : ai.status === 'checking'
        ? 'Starting the local model…'
        : ai.status === 'offline'
          ? 'Local AI isn’t running'
          : 'Not connected yet';
  // The browser's own error ("Failed to fetch") goes in the tooltip, not in the line.
  const statusSub =
    ai.status === 'offline'
      ? `Nothing answers at ${ai.baseUrl}`
      : ai.status === 'online'
        ? [ai.chatModel && `Chat: ${ai.chatModel}`, vision && `Vision: ${vision}`].filter(Boolean).join(' · ') || `${ai.models.length} models available`
        : ai.baseUrl;

  return (
    <div className="settings-section">
      {/* The one place the model's state is shown in full. */}
      <div className="set-row">
        <div className={cx('status-card', `is-${ai.status}`)}>
          <span className="ai-dot" />
          <div className="status-text" title={ai.status === 'offline' ? ai.lastError || undefined : undefined}>
            <div className="status-title">{statusText}</div>
            <div className="status-sub">{statusSub}</div>
          </div>
          <button
            className="btn is-secondary"
            disabled={detecting}
            onClick={async () => {
              setDetecting(true);
              await ai.autodetect();
              setDetecting(false);
            }}
          >
            {detecting ? <Loader2 {...ICON} className="spin" /> : <Radar {...ICON} />} Detect
          </button>
          <button className="icon-btn" onClick={() => void ai.refresh()} aria-label="Refresh" title="Look for models again">
            <RefreshCw {...ICON} />
          </button>
        </div>
      </div>
      <Row title="Server" help="Ollama, or anything that speaks the OpenAI API: LM Studio, llama.cpp, Jan, vLLM.">
        <Segmented
          value={ai.provider}
          options={[
            ['ollama', 'Ollama'],
            ['openai', 'OpenAI-compatible'],
          ]}
          onChange={(v) => ai.set({ provider: v, baseUrl: DEFAULT_URLS[v] })}
        />
      </Row>
      <Row title="Address">
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url !== ai.baseUrl && ai.set({ baseUrl: url })}
          onKeyDown={(e) => e.key === 'Enter' && ai.set({ baseUrl: url })}
          spellCheck={false}
        />
      </Row>
      {ai.provider === 'openai' && (
        <Row title="API key" help="Usually not needed for local servers.">
          <input className="input" type="password" value={ai.apiKey} onChange={(e) => ai.set({ apiKey: e.target.value })} placeholder="Optional" />
        </Row>
      )}

      <div className="settings-group">Models</div>
      <Row title="Chat model" help={`Answers questions, tutors, summarizes.${modelNote(ai.chatModel, ai.models)}`}>
        <ModelSelect value={ai.chatModel} onChange={(v) => ai.set({ chatModel: v })} models={ai.models} filter={(m) => !m.embedding} />
      </Row>
      <Row title="Vision model" help={`Reads your handwriting and what’s on screen.${modelNote(ai.visionModel, ai.models).replace(' Sees images.', '')}`}>
        <ModelSelect
          value={ai.visionModel}
          onChange={(v) => ai.set({ visionModel: v })}
          models={ai.models}
          filter={(m) => !m.embedding && (m.vision || ai.forceVision)}
          none={chatModels.find((m) => m.name === ai.chatModel)?.vision ? 'Same as chat model' : 'None'}
        />
      </Row>
      <Row title="Embedding model" help={`Optional. Lets Ask your notes match meaning, not just words.${modelNote(ai.embedModel, ai.models)}`}>
        <ModelSelect value={ai.embedModel} onChange={(v) => ai.set({ embedModel: v })} models={ai.models} filter={(m) => m.embedding} none="None (keyword search)" />
      </Row>
      <Row
        title="Context size"
        help={
          chatInfo?.contextLength && chatInfo.contextLength < ai.numCtx
            ? `${ai.chatModel} reads up to ${Math.round(chatInfo.contextLength / 1024)}K, so that’s what’s used.`
            : 'How much of a long note the model reads at once. Larger uses more memory.'
        }
      >
        <select className="select" value={ai.numCtx} onChange={(e) => ai.set({ numCtx: Number(e.target.value) })}>
          {[4096, 8192, 16384, 32768, 65536].map((n) => (
            <option key={n} value={n}>
              {n / 1024}K tokens
            </option>
          ))}
        </select>
      </Row>
      <Row title="Creativity" help={`${ai.temperature.toFixed(1)}. Lower is more precise. Answers from your notes always run at 0.15 or below.`}>
        <input
          className="slider set-slider"
          type="range"
          min={0}
          max={1.2}
          step={0.1}
          value={ai.temperature}
          style={{ '--pct': `${(ai.temperature / 1.2) * 100}%` } as React.CSSProperties}
          onChange={(e) => ai.set({ temperature: Number(e.target.value) })}
        />
      </Row>

      <div className="settings-group">Answers</div>
      <SwitchRow
        title="When my notes don’t cover a question, answer from the AI’s own knowledge"
        help="The reply first says your notes don’t cover it, then gives the AI’s answer in a box marked “proceed with caution”. Off: it only says so."
        checked={ai.outsideKnowledge === 'auto'}
        onChange={(v) => ai.set({ outsideKnowledge: v ? 'auto' : 'never' })}
      />
      <SwitchRow
        title="Double-check loosely matched sentences"
        help="A second, quick pass asks the model to quote the passage behind each one, and the quote is checked against your notes. Anything that can’t be backed is boxed."
        checked={ai.doubleCheck}
        onChange={(v) => ai.set({ doubleCheck: v })}
      />

      <div className="settings-group">Handwriting</div>
      <SwitchRow
        title="Read handwriting in the background"
        help="Makes handwritten notes searchable and readable by the AI. Needs a vision model."
        checked={ai.autoTranscribe}
        onChange={(v) => ai.set({ autoTranscribe: v })}
      />
      <SwitchRow title="My chat model can see images" help="Turn on if detection missed it." checked={ai.forceVision} onChange={(v) => ai.set({ forceVision: v })} />

      <div className="settings-group">Get models</div>
      <Row title="Install Ollama from ollama.com, then run one of these in Terminal." stacked>
        <div className="recommend">
          <CopyCmd cmd="ollama pull qwen2.5vl:7b" note="Reads handwriting and math · 6 GB" />
          <CopyCmd cmd="ollama pull gemma3:4b" note="Fast, sees images · 3 GB" />
          <CopyCmd cmd="ollama pull nomic-embed-text" note="Meaning-based search · 0.3 GB" />
          <CopyCmd cmd="ollama pull llama3.2-vision" note="Another vision model · 8 GB" />
        </div>
      </Row>

      <ActivityLog />
    </div>
  );
}

/** What the model has been asked to do: timing, retries and failures — handy when a model is slow or flaky. */
function ActivityLog() {
  const entries = useActivity((s) => s.entries);
  const [testing, setTesting] = useState<string | null>(null);
  const runTest = async () => {
    const ai = useAI.getState();
    if (!ai.chatModel) return;
    setTesting('Testing…');
    try {
      const r = await chatRobust({
        label: 'Connection test',
        model: ai.chatModel,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        maxTokens: 16,
      });
      setTesting(`Answered in ${(r.metrics.totalMs / 1000).toFixed(1)}s${r.metrics.tokensPerSec ? ` · ${Math.round(r.metrics.tokensPerSec)} tokens/s` : ''}`);
    } catch (e) {
      setTesting(`Failed: ${String((e as Error).message ?? e)}`);
    }
  };
  return (
    <>
      <div className="settings-group">Activity</div>
      <Row title="Every request to your model, newest first" help="Questions you ask go ahead of background work." stacked>
        <div className="activity">
          <div className="activity-head">
            <button className="btn is-secondary" onClick={() => void runTest()}>
              Test model
            </button>
            {testing && <span className="activity-test">{testing}</span>}
          </div>
          {entries.length === 0 ? (
            <div className="activity-empty">Nothing yet.</div>
          ) : (
            <div className="activity-list">
              {entries.slice(0, 14).map((e) => (
                <div key={e.id} className="activity-row" title={e.error}>
                  <span className={cx('activity-dot', `is-${e.status}`)} />
                  <span className="activity-label">{e.label}</span>
                  <span className="activity-model">{e.model}</span>
                  <span className="activity-meta">
                    {e.status === 'ok' && e.metrics
                      ? `${(e.metrics.totalMs / 1000).toFixed(1)}s${e.metrics.tokensPerSec ? ` · ${Math.round(e.metrics.tokensPerSec)} tok/s` : ''}`
                      : e.status === 'paused'
                        ? 'paused for your question'
                        : e.status === 'error'
                          ? 'failed'
                          : e.status}
                    {e.attempts > 1 ? ` · ${e.attempts - 1} ${e.attempts === 2 ? 'retry' : 'retries'}` : ''}
                  </span>
                  <span className="activity-time">{formatRelativeTime(e.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Row>
    </>
  );
}

function GeneralSection() {
  const backend = useVault((s) => s.backend);
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const live = Object.values(notes).filter((n) => !n.meta.trashed).length;
  return (
    <div className="settings-section">
      <Row
        title={isElectron ? 'Vault folder' : 'Storage'}
        help={isElectron ? 'Your notes are ordinary files in this folder. Put it in iCloud Drive or Dropbox to sync it, and back it up like any other folder.' : undefined}
        stacked
      >
        <div className="vault-card">
          <FolderOpen {...ICON} />
          <div className="vault-card-text">
            <div className="vault-path" title={backend?.label}>
              {backend?.label}
            </div>
            <div className="vault-stats">
              {live} notes · {folders.length} folders
            </div>
          </div>
          {bridge && (
            <button className="btn is-secondary" onClick={() => void openVaultFolder()}>
              Open another folder…
            </button>
          )}
        </div>
      </Row>
      <Row title="Import" help="PDFs, Markdown files and images become notes.">
        <button className="btn is-secondary" onClick={() => void importFiles()}>
          Import…
        </button>
      </Row>
    </div>
  );
}

function WritingSection() {
  const s = useSettings();
  const t = useTools();
  return (
    <div className="settings-section">
      <Row title="Line spacing" help="Typed text and handwriting share these lines.">
        <Segmented
          value={s.lineSpacing}
          options={(['compact', 'comfortable', 'roomy'] as LineSpacing[]).map((v) => [v, v[0].toUpperCase() + v.slice(1)])}
          onChange={(v) => s.set({ lineSpacing: v })}
        />
      </Row>
      <Row title="Typeface">
        <Segmented
          value={s.font}
          options={
            [
              ['sans', 'Sans'],
              ['serif', 'Serif'],
              ['mono', 'Mono'],
            ] as [FontChoice, string][]
          }
          onChange={(v) => s.set({ font: v })}
        />
      </Row>
      <Row title="Page size" help="Matches the exported PDF.">
        <Segmented
          value={s.pageSize}
          options={
            [
              ['letter', 'US Letter'],
              ['a4', 'A4'],
            ] as [PageSize, string][]
          }
          onChange={(v) => s.set({ pageSize: v })}
        />
      </Row>
      <SwitchRow title="Fit the page to the window" checked={s.fitWidth} onChange={(v) => s.set({ fitWidth: v })} />
      <SwitchRow title="Check spelling" checked={s.spellcheck} onChange={(v) => s.set({ spellcheck: v })} />

      <div className="settings-group">Marker</div>
      <SwitchRow
        title="Stylus always draws"
        help="With a drawing tablet or a Sidecar Apple Pencil, the pen writes and the mouse types, with no switching."
        checked={t.stylusDraws}
        onChange={(v) => t.set({ stylusDraws: v })}
      />
      <SwitchRow
        title="Hold to snap shapes"
        help="Pause at the end of a stroke to turn it into a clean line, arrow, circle or box."
        checked={t.holdToSnap}
        onChange={(v) => t.set({ holdToSnap: v })}
      />
      <SwitchRow title="Straighten highlighter strokes" checked={t.highlighter.straighten} onChange={(v) => t.setHighlighter({ straighten: v })} />
    </div>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    'General',
    [
      [`${MOD}N`, 'New note'],
      [`${SHIFT}${MOD}Y`, 'New homework'],
      [`${MOD}K`, 'Search notes and commands'],
      [`${MOD}J`, 'Assistant'],
      [`${SHIFT}${MOD}L`, 'Ask your notes'],
      [`${SHIFT}${MOD}E`, 'Review'],
      [`${MOD}\\`, 'Show or hide the sidebar'],
      [`${MOD}[  /  ${MOD}]`, 'Back / forward'],
      [`${MOD},`, 'Settings'],
      [`${MOD}P`, 'Export as PDF'],
      [`${MOD}=  /  ${MOD}-`, 'Zoom page'],
    ],
  ],
  [
    'Writing by hand',
    [
      [`${ALT}P`, 'Marker'],
      [`${ALT}H`, 'Highlighter'],
      [`${ALT}E`, 'Eraser'],
      [`${ALT}S  /  ${ALT}L`, 'Select'],
      ['Hold Space', 'Move the Select box'],
      [`Hold ${ALT}`, 'Grow the box from the center'],
      ['Esc', 'Cancel the box'],
      [`${ALT}T`, 'Type'],
      ['Just type', 'Switch to typing below your handwriting'],
      ['Esc', 'Back to the marker'],
      ['Hold', 'Snap a stroke into a shape'],
      [`${MOD}D`, 'Sketch inline (while typing)'],
      [`${MOD} + drag`, 'Move handwriting with the pen'],
      [`${ALT} + drag`, 'Move handwriting without snapping'],
      ['← → ↑ ↓', 'Nudge selected handwriting'],
      [`${ALT}↑ ↓`, 'Move it a ruled line'],
    ],
  ],
  [
    'Formatting',
    [
      ['/', 'Insert any block'],
      ['# ## ###', 'Headings'],
      ['- or 1.', 'Lists'],
      ['[]', 'Checklist'],
      ['$x^2$', 'Inline math'],
      ['$$ + space', 'Equation'],
      [`${MOD}B / ${MOD}I / ${MOD}U`, 'Bold / italic / underline'],
      [`${SHIFT}${MOD}H`, 'Highlight'],
      [`${ALT}${SHIFT}↑ ↓`, 'Move block'],
    ],
  ],
];

function ShortcutsSection() {
  return (
    <div className="settings-section">
      <div className="shortcut-groups">
        {SHORTCUTS.map(([g, list]) => (
          <div key={g} className="shortcut-group">
            <div className="shortcut-group-title">{g}</div>
            {list.map(([k, d]) => (
              <div key={d} className="shortcut-row">
                <span>{d}</span>
                <kbd>{k}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function AboutSection() {
  const [info, setInfo] = useState<{ version: string; electron: string } | null>(null);
  useEffect(() => {
    bridge
      ?.appInfo()
      .then(setInfo)
      .catch(() => undefined);
  }, []);
  return (
    <div className="settings-section about">
      <div className="about-mark">
        <NibMark size={44} />
      </div>
      <div className="about-name">Nib</div>
      <p>{info ? `Version ${info.version} · Electron ${info.electron}` : 'Version 0.1.0'}</p>
      <p>A notebook for typing and handwriting, with a local AI that answers from your own notes.</p>
    </div>
  );
}
