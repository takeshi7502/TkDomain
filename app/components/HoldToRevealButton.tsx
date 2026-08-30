'use client';

import type { KeyboardEvent, PointerEvent } from 'react';

type HoldToRevealButtonProps = {
  label: string;
  onRevealChange: (visible: boolean) => void;
};

function isRevealKey(event: KeyboardEvent<HTMLButtonElement>) {
  return event.key === ' ' || event.key === 'Enter';
}

/**
 * Keeps sensitive values hidden by default. The value is only visible while
 * the control is being pressed (or held with Space/Enter from a keyboard).
 */
export function HoldToRevealButton({ label, onRevealChange }: HoldToRevealButtonProps) {
  function reveal(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    onRevealChange(true);
  }

  function conceal() {
    onRevealChange(false);
  }

  function revealWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!isRevealKey(event)) return;
    event.preventDefault();
    onRevealChange(true);
  }

  function concealWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!isRevealKey(event)) return;
    event.preventDefault();
    onRevealChange(false);
  }

  return (
    <button
      className="visibility-toggle"
      type="button"
      onPointerDown={reveal}
      onPointerUp={conceal}
      onPointerCancel={conceal}
      onPointerLeave={conceal}
      onKeyDown={revealWithKeyboard}
      onKeyUp={concealWithKeyboard}
      onBlur={conceal}
      aria-label={`Giữ để hiện ${label}`}
      title={`Giữ để hiện ${label}`}
    >
      ◉
    </button>
  );
}
