import { create } from 'zustand';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx, uid } from '../../lib/util';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  title: string;
  detail?: string;
  action?: { label: string; run(): void };
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'>, ms?: number): string;
  dismiss(id: string): void;
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ms = 3800) => {
    const id = uid('t');
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (title: string, detail?: string, action?: Toast['action']) => useToasts.getState().push({ kind: 'info', title, detail, action }),
  success: (title: string, detail?: string) => useToasts.getState().push({ kind: 'success', title, detail }),
  error: (title: string, detail?: string) => useToasts.getState().push({ kind: 'error', title, detail }, 6500),
};

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return createPortal(
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `is-${t.kind}`)} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.detail && <div className="toast-detail">{t.detail}</div>}
          </div>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={20} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
