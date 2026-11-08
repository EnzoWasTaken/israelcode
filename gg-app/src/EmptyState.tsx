import type { ReactNode } from "react";

/**
 * One helpful line for an empty list or a search with no match: what goes
 * here, then the next step (a button or two from the screen's own handlers).
 */
export function EmptyState({
  message,
  children,
  className,
}: {
  message: ReactNode;
  children?: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={className ? `empty-state ${className}` : "empty-state"}>
      <span className="empty-state-line">{message}</span>
      {children && <span className="empty-state-actions">{children}</span>}
    </div>
  );
}
