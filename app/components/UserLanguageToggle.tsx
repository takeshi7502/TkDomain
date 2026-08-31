'use client';

import { useSyncExternalStore } from 'react';

export type UserLanguage = 'vi' | 'en';

const STORAGE_KEY = 'takeshi-domains-user-language';
const LANGUAGE_EVENT = 'takeshi-domains-language-change';

function readLanguage(): UserLanguage {
  if (typeof window === 'undefined') return 'vi';
  return window.localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'vi';
}

function subscribe(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener(LANGUAGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(LANGUAGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useUserLanguage() {
  const language = useSyncExternalStore<UserLanguage>(subscribe, readLanguage, () => 'vi');

  function changeLanguage(next: UserLanguage) {
    window.localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(LANGUAGE_EVENT));
  }

  return { language, setLanguage: changeLanguage };
}

export function UserLanguageToggle({ language, onChange }: { language: UserLanguage; onChange: (language: UserLanguage) => void }) {
  const nextLanguage: UserLanguage = language === 'vi' ? 'en' : 'vi';
  return (
    <button
      className="language-toggle"
      type="button"
      onClick={() => onChange(nextLanguage)}
      title={language === 'vi' ? 'Switch to English' : 'Chuyển sang Tiếng Việt'}
      aria-label={language === 'vi' ? 'Switch to English' : 'Chuyển sang Tiếng Việt'}
    >
      {nextLanguage.toUpperCase()}
    </button>
  );
}
