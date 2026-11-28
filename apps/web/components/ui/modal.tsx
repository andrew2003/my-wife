"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./buttons";

export interface ModalProps {
  open: boolean;
  title: string;
  /** Accessible name of the close control. */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

function Modal({
  open,
  title,
  closeLabel,
  onClose,
  children,
  kind,
}: ModalProps & { kind: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={kind}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="mw-modal-head">
        <h2 id={titleId} className="mw-modal-title">
          {title}
        </h2>
        <IconButton label={closeLabel} onClick={onClose}>
          <span aria-hidden="true">×</span>
        </IconButton>
      </div>
      <div className="mw-modal-body">{children}</div>
    </dialog>
  );
}

/** Centered modal on the native dialog: focus trap, Escape and backdrop come from the browser. */
export function Dialog(props: ModalProps) {
  return <Modal {...props} kind="mw-dialog" />;
}

/** Bottom sheet; same behavior as Dialog, anchored to the bottom edge. */
export function Sheet(props: ModalProps) {
  return <Modal {...props} kind="mw-sheet" />;
}
