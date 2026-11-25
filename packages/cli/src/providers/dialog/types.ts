import type { ReactNode } from "react";

export type DialogConfig = {
  title: string;
  children: ReactNode;
  /**
   * Runs once whenever this dialog goes away, for any reason: `close()`,
   * Escape, a click on the backdrop, Ctrl+C, or another dialog replacing it.
   * Callers waiting on an answer use it to treat "dismissed" as a decision.
   */
  onClose?: () => void;
};
