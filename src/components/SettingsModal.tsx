import { useEffect, useState } from 'react';
import { Check, Copy, Cpu, FolderOpen, Info, Keyboard, Loader2, PenLine, RefreshCw, Radar, HardDrive, X } from 'lucide-react';
import { Modal } from './common/Modal';
import { useUI, type SettingsSection } from '../state/ui';
import { useAI } from '../state/ai';
import { useSettings, type FontChoice, type LineSpacing, type PageSize } from '../state/settings';
import { useTools } from '../state/tools';
import { useVault } from '../state/vault';
import { DEFAULT_URLS, type ModelInfo } from '../lib/ai/providers';
import { PAPERS, PaperSwatch } from '../editor/ui/PageHeader';
import { Toggle } from '../editor/ui/InkToolbar';
import { bridge, isElectron, MOD, SHIFT, ALT } from '../lib/platform';
import { openVaultFolder } from '../lib/commands';
import { cx, formatRelativeTime } from '../lib/util';
import { chatRobust, useActivity } from '../lib/ai/engine';
import { NibMark } from './TopBar';

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { id: 'ai', label: 'Local AI', icon: <Cpu size={20} /> },
  { id: 'writing', label: 'Writing & ink', icon: <PenLine size={20} /> },
  { id: 'vault', label: 'Vault', icon: <HardDrive size={20} /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={20} /> },
  { id: 'about', label: 'About', icon: <Info size={20} /> },
];

export function SettingsModal() {
  const section = useUI((s) => s.settings);
  const close = () => useUI.getState().openSettings(null);
  return (
    <Modal open={!!section} onClose={close} width={960} bare className="settings">
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
        <button className="icon-btn settings-close" onClick={close} aria-label="Close">
          <X size={20} />
        </button>
        <div className="settings-body">
          {section === 'ai' && <AISection />}
          {section === 'writing' && <WritingSection />}
          {section === 'vault' && <VaultSection />}
          {section === 'shortcuts' && <ShortcutsSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </Modal>
  );
}

/** A Google Drive settings row: the setting's name on the left, its control and a line of help on the right. */
function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-body">
        <div className="field-control">{children}</div>
        {hint && <div className="field-hint">{hint}</div>}
      </div>
    </div>
  );
}

/** M3 segmented buttons: the chosen segment is filled and shows a check. */
function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} role="radio" aria-checked={value === v} className={cx(value === v && 'is-active')} onClick={() => onChange(v)}>
          {value === v && <Check size={18} />}
          {label}
        </button>
      ))}
    </div>
  );
}

function modelLabel(m: ModelInfo) {
  const parts = [m.name];
  if (m.params) parts.push(m.params);
  return parts.join(' · ');
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
      {!known && value && <option value={value}>{value} (not found)</option>}
      {list.map((m) => (
        <option key={m.name} value={m.name}>
          {modelLabel(m)}
          {m.vision ? '  — sees images' : ''}
          {m.thinking ? '  — reasoning' : ''}
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
        {ok ? <Check size={18} /> : <Copy size={18} />}
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
  const statusText =
    ai.status === 'online'
      ? `Connected${ai.serverLabel ? ` to ${ai.serverLabel}` : ''} · ${ai.models.length} model${ai.models.length === 1 ? '' : 's'} available`
      : ai.status === 'checking'
        ? 'Connecting…'
        : ai.status === 'offline'
          ? 'Can’t reach a model server at this address'
          : 'Not connected yet';

  return (
    <div className="settings-section">
      <h2>Local AI</h2>
      <p className="settings-lead">
        Nib talks only to a model running on your own machine. Your notes never leave it.
      </p>

      <Field label="Connection">
        <div className={cx('status-card', `is-${ai.status}`)}>
          <span className="ai-dot" />
          <div className="status-text">
            <div className="status-title">{statusText}</div>
            <div className="status-sub">
              {ai.status === 'offline' ? ai.lastError : `${ai.provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible'} · ${ai.baseUrl}`}
            </div>
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
            {detecting ? <Loader2 size={18} className="spin" /> : <Radar size={18} />} Detect
          </button>
          <button className="icon-btn" onClick={() => void ai.refresh()} aria-label="Refresh" title="Refresh model list">
            <RefreshCw size={18} />
          </button>
        </div>
      </Field>
      <Field label="Server" hint="Ollama, or anything that speaks the OpenAI API — LM Studio, llama.cpp, Jan, vLLM.">
        <Segmented
          value={ai.provider}
          options={[
            ['ollama', 'Ollama'],
            ['openai', 'OpenAI-compatible'],
          ]}
          onChange={(v) => ai.set({ provider: v, baseUrl: DEFAULT_URLS[v] })}
        />
      </Field>
      <Field label="Address">
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url !== ai.baseUrl && ai.set({ baseUrl: url })}
          onKeyDown={(e) => e.key === 'Enter' && ai.set({ baseUrl: url })}
          spellCheck={false}
        />
      </Field>
      {ai.provider === 'openai' && (
        <Field label="API key" hint="Usually not needed for local servers.">
          <input className="input" type="password" value={ai.apiKey} onChange={(e) => ai.set({ apiKey: e.target.value })} placeholder="optional" />
        </Field>
      )}

      <Field label="Chat model" hint="Answers questions, tutors, summarises.">
        <ModelSelect value={ai.chatModel} onChange={(v) => ai.set({ chatModel: v })} models={ai.models} filter={(m) => !m.embedding} />
      </Field>
      <Field label="Vision model" hint="Reads your handwriting and what’s on screen.">
        <ModelSelect
          value={ai.visionModel}
          onChange={(v) => ai.set({ visionModel: v })}
          models={ai.models}
          filter={(m) => !m.embedding && (m.vision || ai.forceVision)}
          none={chatModels.find((m) => m.name === ai.chatModel)?.vision ? 'Same as chat model' : 'None'}
        />
      </Field>
      <Field label="Embedding model" hint="Optional. Makes “Ask your notes” understand meaning, not just keywords.">
        <ModelSelect
          value={ai.embedModel}
          onChange={(v) => ai.set({ embedModel: v })}
          models={ai.models}
          filter={(m) => m.embedding}
          none="None — keyword search"
        />
      </Field>
      <Field
        label="Context size"
        hint={
          chatInfo?.contextLength && chatInfo.contextLength < ai.numCtx
            ? `${ai.chatModel} supports up to ${Math.round(chatInfo.contextLength / 1024)}K — Nib will use that.`
            : 'How much of a long note the model can read at once. Larger uses more memory.'
        }
      >
        <select className="select" value={ai.numCtx} onChange={(e) => ai.set({ numCtx: Number(e.target.value) })}>
          {[4096, 8192, 16384, 32768, 65536].map((n) => (
            <option key={n} value={n}>
              {n / 1024}K tokens
            </option>
          ))}
        </select>
      </Field>
      <Field label="Creativity" hint={`${ai.temperature.toFixed(1)} — lower is more precise. Answers from your notes always run at 0.15 or below.`}>
        <input
          className="slider"
          type="range"
          min={0}
          max={1.2}
          step={0.1}
          value={ai.temperature}
          style={{ '--pct': `${(ai.temperature / 1.2) * 100}%` } as React.CSSProperties}
          onChange={(e) => ai.set({ temperature: Number(e.target.value) })}
        />
      </Field>
      <Field label="Answers">
        <div className="toggles">
          <Toggle
            checked={ai.outsideKnowledge === 'auto'}
            onChange={(v) => ai.set({ outsideKnowledge: v ? 'auto' : 'never' })}
            label="When my notes don’t cover a question, answer from the AI’s own knowledge"
            hint="Nib says first that your notes don’t cover it, and shows that answer in a box marked “proceed with caution”. Off: it only says so."
          />
          <Toggle
            checked={ai.doubleCheck}
            onChange={(v) => ai.set({ doubleCheck: v })}
            label="Double-check loosely matched sentences"
            hint="A second, quick pass asks the model to quote the passage behind each one; Nib checks the quote itself. Anything it can’t back is boxed."
          />
        </div>
      </Field>
      <Field label="Handwriting">
        <div className="toggles">
          <Toggle
            checked={ai.autoTranscribe}
            onChange={(v) => ai.set({ autoTranscribe: v })}
            label="Read handwriting in the background"
            hint="Makes handwritten notes searchable and visible to the assistant (needs a vision model)."
          />
          <Toggle
            checked={ai.forceVision}
            onChange={(v) => ai.set({ forceVision: v })}
            label="My chat model can see images"
            hint="Turn on if detection missed it."
          />
        </div>
      </Field>

      <Field label="Get models" hint="Install Ollama from ollama.com, then run one of these in Terminal.">
        <div className="recommend">
          <CopyCmd cmd="ollama pull qwen2.5vl:7b" note="Reads handwriting & math · 6 GB" />
          <CopyCmd cmd="ollama pull gemma3:4b" note="Fast, sees images · 3 GB" />
          <CopyCmd cmd="ollama pull nomic-embed-text" note="Semantic search · 0.3 GB" />
          <CopyCmd cmd="ollama pull llama3.2-vision" note="Alternative vision model · 8 GB" />
        </div>
      </Field>

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
    <Field label="Activity" hint="Every request to your model, newest first. Questions you ask jump ahead of background work.">
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
    </Field>
  );
}

function WritingSection() {
  const s = useSettings();
  const t = useTools();
  return (
    <div className="settings-section">
      <h2>Writing & ink</h2>
      <Field label="Default paper" hint="For new notes. Change a note’s paper with the Paper button in its toolbar.">
        <div className="paper-picks">
          {PAPERS.map((p) => (
            <button key={p.id} className={cx('paper-pick', s.paper === p.id && 'is-active')} onClick={() => s.set({ paper: p.id })}>
              <PaperSwatch paper={p.id} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Line spacing" hint="Typed text and handwriting share these lines.">
        <Segmented
          value={s.lineSpacing}
          options={(['compact', 'comfortable', 'roomy'] as LineSpacing[]).map((v) => [v, v[0].toUpperCase() + v.slice(1)])}
          onChange={(v) => s.set({ lineSpacing: v })}
        />
      </Field>
      <Field label="Typeface">
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
      </Field>
      <Field label="Page size" hint="Matches the exported PDF.">
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
      </Field>
      <Field label="Page">
        <div className="toggles">
          <Toggle checked={s.fitWidth} onChange={(v) => s.set({ fitWidth: v })} label="Fit the page to the window" />
          <Toggle checked={s.spellcheck} onChange={(v) => s.set({ spellcheck: v })} label="Check spelling" />
        </div>
      </Field>
      <Field label="Pen">
        <div className="toggles">
          <Toggle
            checked={t.stylusDraws}
            onChange={(v) => t.set({ stylusDraws: v })}
            label="Stylus always draws"
            hint="With a drawing tablet or Sidecar Apple Pencil, the pen writes and the mouse types — no switching."
          />
          <Toggle
            checked={t.holdToSnap}
            onChange={(v) => t.set({ holdToSnap: v })}
            label="Hold to snap shapes"
            hint="Pause at the end of a stroke to turn it into a clean line, circle or box."
          />
          <Toggle checked={t.highlighter.straighten} onChange={(v) => t.setHighlighter({ straighten: v })} label="Straighten highlighter strokes" />
        </div>
      </Field>
    </div>
  );
}

function VaultSection() {
  const backend = useVault((s) => s.backend);
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const live = Object.values(notes).filter((n) => !n.meta.trashed).length;
  return (
    <div className="settings-section">
      <h2>Vault</h2>
      <p className="settings-lead">
        {isElectron
          ? 'Your notes are ordinary files in a folder on your Mac — put it in iCloud Drive or Dropbox to sync, and back it up like any other folder.'
          : 'In the browser, notes are stored in this browser’s local storage.'}
      </p>
      <Field label={isElectron ? 'Folder' : 'Storage'}>
        <div className="vault-card">
          <FolderOpen size={20} />
          <div className="vault-card-text">
            <div className="vault-path">{backend?.label}</div>
            <div className="vault-stats">
              {live} notes · {folders.length} folders
            </div>
          </div>
        </div>
        {bridge && (
          <button className="btn is-secondary vault-open" onClick={() => void openVaultFolder()}>
            Open another folder…
          </button>
        )}
      </Field>
    </div>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    'General',
    [
      [`${MOD}N`, 'New note'],
      [`${SHIFT}${MOD}Y`, 'New homework'],
      [`${MOD}K`, 'Quick open & commands'],
      [`${MOD}J`, 'Assistant'],
      [`${SHIFT}${MOD}L`, 'Ask your notes'],
      [`${MOD}\\`, 'Toggle sidebar'],
      [`${MOD}P`, 'Export as PDF'],
      [`${MOD}=  /  ${MOD}-`, 'Zoom page'],
    ],
  ],
  [
    'Writing by hand',
    [
      [`${ALT}P`, 'Pen'],
      [`${ALT}H`, 'Highlighter'],
      [`${ALT}E`, 'Eraser'],
      [`${ALT}L`, 'Lasso'],
      [`${ALT}S`, 'Shapes'],
      [`${ALT}A`, 'Ask AI about an area'],
      ['Just type', 'Switch to typing below your handwriting'],
      ['Esc', 'Back to the pen'],
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
      <h2>Keyboard shortcuts</h2>
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
        <NibMark size={64} />
      </div>
      <h2>Nib</h2>
      <p>A notebook where typing and handwriting share the page — and a study assistant that runs entirely on your own computer.</p>
      <p className="muted">{info ? `Version ${info.version} · Electron ${info.electron}` : 'Version 0.1.0'}</p>
    </div>
  );
}
