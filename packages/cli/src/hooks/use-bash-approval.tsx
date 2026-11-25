import { useCallback, useEffect, useRef } from "react";
import { toolInputSchemas } from "@devcode/shared";
import { useDialog } from "../providers/dialog";
import {
  BashApprovalDialogContent,
  type BashApprovalDecision,
} from "../components/dialogs";

/**
 * Asks the user before the model runs a shell command.
 *
 * `requestApproval` resolves to true (run it) or false (don't). Requests are
 * queued, because the model can ask for several commands at once and only one
 * dialog fits on screen. Dismissing the dialog in any way counts as "no".
 */
export function useBashApproval() {
  const { open, close } = useDialog();
  const allowForSessionRef = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const isPromptOpenRef = useRef(false);
  const isMountedRef = useRef(true);

  const askUser = useCallback(
    (input: unknown) => {
      if (!isMountedRef.current) return Promise.resolve(false);
      if (allowForSessionRef.current) return Promise.resolve(true);

      // Show what the model sent even if it is malformed; executeLocalTool
      // rejects bad input afterwards anyway.
      const parsed = toolInputSchemas.bash.safeParse(input);
      const command = parsed.success
        ? parsed.data.command
        : JSON.stringify(input);
      const description = parsed.success ? parsed.data.description : undefined;

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (decision: BashApprovalDecision) => {
          if (settled) return;
          settled = true;
          isPromptOpenRef.current = false;
          if (decision === "allow-session") allowForSessionRef.current = true;
          resolve(decision !== "deny");
        };

        isPromptOpenRef.current = true;
        open({
          title: "Run this command?",
          onClose: () => settle("deny"),
          children: (
            <BashApprovalDialogContent
              command={command}
              description={description}
              cwd={process.cwd()}
              onDecide={(decision) => {
                settle(decision);
                close();
              }}
            />
          ),
        });
      });
    },
    [open, close],
  );

  const requestApproval = useCallback(
    (input: unknown) => {
      const result = queueRef.current.then(() => askUser(input));
      queueRef.current = result.catch(() => undefined);
      return result;
    },
    [askUser],
  );

  // Leaving the session must not leave a prompt on screen for a chat that no
  // longer exists. Closing it settles the pending request as "deny".
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (isPromptOpenRef.current) close();
    };
  }, [close]);

  return { requestApproval };
}
