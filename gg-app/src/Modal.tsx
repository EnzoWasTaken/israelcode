import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "./phosphor-icons";
import { theme } from "./theme";
import { useDialogFocus } from "./dialog-focus";
import { withViewTransition } from "./view-transition";
import { ModalEmbedProvider, useModalEmbedState } from "./modal-embed";

interface ModalProps {
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  /** Extra class on the `.modal` box (e.g. width overrides). */
  className?: string;
  /** Async dismissals own the transition around their eventual removal. */
  animateDismiss?: boolean;
}

/**
 * Reusable centered modal with Escape, focus containment, and focus return.
 * Inside `<EmbeddedModal>` (the Settings screen's tabs) it renders its content
 * as a page section instead.
 */
export function Modal(props: ModalProps): React.ReactElement {
  return useModalEmbedState() === "embed" ? (
    <ModalSection {...props} />
  ) : (
    <ModalDialog {...props} />
  );
}

/**
 * The page form: the modal's content in flow, nothing floating. Its title is
 * the section's accessible name only; the page header names it on screen.
 */
function ModalSection({ title, children, className }: ModalProps): React.ReactElement {
  const titleId = useId();
  return (
    <section
      className={className ? `settings-panel ${className}` : "settings-panel"}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="sr-only">
        {title}
      </h2>
      <ModalEmbedProvider state="panel">{children}</ModalEmbedProvider>
    </section>
  );
}

function ModalDialog({
  title,
  children,
  onClose,
  className,
  animateDismiss = true,
}: ModalProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Escape, backdrop, × and ModalDismissButton share dismissal motion.
  // Save/Confirm/navigation remain separate actions owned by the parent.
  const dismiss = (): void => {
    if (animateDismiss) withViewTransition(onClose);
    else onClose();
  };
  useDialogFocus(dialogRef, dismiss);

  // Portalled to <body>. A modal opened from a trigger nested inside the app
  // shell (the radio button lives in the nav bar) would otherwise be trapped in
  // that ancestor's stacking context, and paint UNDER later siblings — the
  // transcript showed straight through the panel. Rendering at the document
  // root makes every modal immune to wherever its trigger happens to live.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={dialogRef}
        className={className ? `modal ${className}` : "modal"}
        style={{ background: theme.surface2, borderColor: theme.border }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId} className="modal-title" style={{ color: theme.text }}>
            {title}
          </h2>
          <button
            className="modal-close"
            type="button"
            aria-label="Close"
            title="Close"
            onClick={dismiss}
          >
            <XIcon size={14} weight="bold" aria-hidden="true" />
          </button>
        </div>
        {/* A dialog's own contents are never embedded, even when a page
            section opened it. */}
        <ModalEmbedProvider state="none">{children}</ModalEmbedProvider>
      </div>
    </div>,
    document.body,
  );
}
