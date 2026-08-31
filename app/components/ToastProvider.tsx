'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type ToastTone = 'success' | 'error' | 'info';
export type ToastInput = { tone: ToastTone; text: string; duration?: number };
type Toast = ToastInput & { id: number };

type ToastContextValue = {
  pushToast: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function defaultDuration(tone: ToastTone) {
  if (tone === 'error') return 8_000;
  if (tone === 'info') return 6_000;
  return 5_000;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((input: ToastInput) => {
    const id = ++nextId.current;
    const toast: Toast = { ...input, id };
    setToasts((current) => [toast, ...current].slice(0, 4));
    const timer = window.setTimeout(() => dismissToast(id), input.duration ?? defaultDuration(input.tone));
    timers.current.set(id, timer);
  }, [dismissToast]);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
  }, []);

  const value = useMemo(() => ({ pushToast }), [pushToast]);

  return <ToastContext.Provider value={value}>{children}
    <aside className="toast-viewport" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => <article className={`toast toast-${toast.tone}`} key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'}>
        <span className="toast-mark" aria-hidden="true">{toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '!' : 'i'}</span>
        <p>{toast.text}</p>
        <button type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification" title="Dismiss">×</button>
      </article>)}
    </aside>
  </ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider.');
  return context;
}

export function useNoticeToast(notice: ToastInput | null) {
  const { pushToast } = useToast();
  useEffect(() => {
    if (notice) pushToast(notice);
  }, [notice, pushToast]);
}
