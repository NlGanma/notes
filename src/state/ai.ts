import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_URLS, detectServers, listModels, pickDefaults, pingServer, type ModelInfo, type ProviderConfig, type ProviderKind } from '../lib/ai/providers';
import type { OutsideKnowledge } from '../lib/ai/policy';

export interface AISettings {
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  /** Model used for anything with images (handwriting). '' = use the chat model. */
  visionModel: string;
  embedModel: string;
  temperature: number;
  numCtx: number;
  /** Read handwriting in the background so it is searchable. */
  autoTranscribe: boolean;
  /**
   * When the notes don't cover a question: `auto` says so, then answers from the
   * model's own knowledge in a box marked "proceed with caution"; `never` only says so.
   */
  outsideKnowledge: OutsideKnowledge;
  /** Ask the model to quote the passage behind loosely matched sentences (checked in code). */
  doubleCheck: boolean;
  /** Treat the chat model as vision-capable even if detection says otherwise. */
  forceVision: boolean;
}

export type AIStatus = 'unknown' | 'checking' | 'online' | 'offline';

interface AIState extends AISettings {
  status: AIStatus;
  models: ModelInfo[];
  serverLabel: string;
  lastError: string | null;
  set(p: Partial<AISettings>): void;
  refresh(): Promise<void>;
  /** Scans the usual ports for Ollama / LM Studio / llama.cpp and configures the first one found. */
  autodetect(): Promise<boolean>;
  /**
   * Quiet health check (no "checking" flicker): notices when the server goes
   * away or comes back, and when models are pulled or removed.
   * Returns the transition, if any.
   */
  heartbeat(): Promise<'lost' | 'restored' | null>;
}

export const useAI = create<AIState>()(
  persist(
    (set, get) => ({
      provider: 'ollama',
      baseUrl: DEFAULT_URLS.ollama,
      apiKey: '',
      chatModel: '',
      visionModel: '',
      embedModel: '',
      temperature: 0.2,
      numCtx: 16384,
      autoTranscribe: true,
      outsideKnowledge: 'auto',
      doubleCheck: true,
      forceVision: false,
      status: 'unknown',
      models: [],
      serverLabel: '',
      lastError: null,
      set: (p) => {
        set(p);
        if (p.provider !== undefined || p.baseUrl !== undefined || p.apiKey !== undefined) void get().refresh();
      },
      refresh: async () => {
        set({ status: 'checking' });
        try {
          const models = await listModels(providerConfig(get()));
          const patch: Partial<AIState> = { models, status: 'online', lastError: null };
          const names = new Set(models.map((m) => m.name));
          const defaults = pickDefaults(models);
          if (!get().chatModel || !names.has(get().chatModel)) patch.chatModel = defaults.chatModel;
          if (get().visionModel && !names.has(get().visionModel)) patch.visionModel = defaults.visionModel;
          if (!get().visionModel && defaults.visionModel && !models.find((m) => m.name === (patch.chatModel ?? get().chatModel))?.vision)
            patch.visionModel = defaults.visionModel;
          if (!get().embedModel || !names.has(get().embedModel)) patch.embedModel = defaults.embedModel;
          set(patch);
        } catch (e) {
          set({ status: 'offline', models: [], lastError: String((e as Error).message ?? e) });
        }
      },
      heartbeat: async () => {
        const was = get().status;
        if (was === 'checking') return null;
        try {
          const names = await pingServer(providerConfig(get()));
          const known = get().models.map((m) => m.name);
          if (was !== 'online') {
            await get().refresh();
            return get().status === 'online' && was === 'offline' ? 'restored' : null;
          }
          if (names.length !== known.length || names.some((n) => !known.includes(n))) await get().refresh();
          return null;
        } catch (e) {
          if (was === 'online') {
            set({ status: 'offline', lastError: String((e as Error).message ?? e) });
            return 'lost';
          }
          return null;
        }
      },
      autodetect: async () => {
        set({ status: 'checking' });
        const found = await detectServers({ provider: get().provider, baseUrl: get().baseUrl, apiKey: get().apiKey });
        const withModels = found.find((f) => f.models.some((m) => !m.embedding)) ?? found[0];
        if (!withModels) {
          set({ status: 'offline', lastError: 'No local model server found on the usual ports.' });
          return false;
        }
        const d = pickDefaults(withModels.models);
        set({
          provider: withModels.provider,
          baseUrl: withModels.baseUrl,
          models: withModels.models,
          serverLabel: withModels.label,
          status: 'online',
          lastError: null,
          chatModel: d.chatModel,
          visionModel: d.visionModel && d.visionModel !== d.chatModel ? d.visionModel : '',
          embedModel: d.embedModel,
        });
        return true;
      },
    }),
    {
      name: 'nib.ai',
      version: 2,
      // v1 had a "strict library" switch and a livelier default temperature.
      migrate: (old, version) => {
        const o = (old ?? {}) as Record<string, unknown>;
        if (version < 2) {
          delete o.strictLibrary;
          o.outsideKnowledge = 'auto';
          if (o.temperature === 0.4) o.temperature = 0.2;
        }
        return o as never;
      },
      partialize: (s) => ({
        provider: s.provider,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        chatModel: s.chatModel,
        visionModel: s.visionModel,
        embedModel: s.embedModel,
        temperature: s.temperature,
        numCtx: s.numCtx,
        autoTranscribe: s.autoTranscribe,
        outsideKnowledge: s.outsideKnowledge,
        doubleCheck: s.doubleCheck,
        forceVision: s.forceVision,
        serverLabel: s.serverLabel,
      }),
    },
  ),
);

export function providerConfig(s: Pick<AISettings, 'provider' | 'baseUrl' | 'apiKey'> = useAI.getState()): ProviderConfig {
  return { provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey || undefined };
}

/** The model to use when images are attached, or null when none can see. */
export function visionModel(s = useAI.getState()): string | null {
  if (s.visionModel) return s.visionModel;
  const chat = s.models.find((m) => m.name === s.chatModel);
  if (s.forceVision || chat?.vision) return s.chatModel || null;
  return null;
}

export function aiReady(s = useAI.getState()): boolean {
  return s.status === 'online' && !!s.chatModel;
}
