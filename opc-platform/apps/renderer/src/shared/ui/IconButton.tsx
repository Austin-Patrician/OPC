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
  disabled = false,
  className = '',
  type = 'button',
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`no-drag inline-flex items-center justify-center rounded-lg p-1 transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'text-accent' : ''} ${className}`}
    >
      {children}
    </button>
  );
}
