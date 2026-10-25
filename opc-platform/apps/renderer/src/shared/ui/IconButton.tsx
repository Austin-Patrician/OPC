import type { ReactNode } from 'react';

/**
 * Minimal icon button used across the chrome. Keeps hover/focus/ARIA consistent
 * so individual components never re-invent accessibility.
 */
export function IconButton({
  children,
  label,
  onClick,
  active = false,
  className = '',
  type = 'button',
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`no-drag inline-flex items-center justify-center rounded-lg p-1 transition-colors hover:text-accent ${active ? 'text-accent' : ''} ${className}`}
    >
      {children}
    </button>
  );
}
