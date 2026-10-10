"use client";

/**
 * The shell's "Leave this page?" question for navigation guards that bring no dialog of their own
 * (lib/navigation-guard.ts). Staying gives focus back to the link or control that started the navigation.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/silicon-ui/button/button";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { answerLeaveQuestion, usePendingLeaveQuestion, type PendingQuestion } from "@/lib/navigation-guard";
import styles from "./shell.module.css";

export function LeaveQuestionHost() {
  const pending = usePendingLeaveQuestion();
  // The last question stays on screen while the dialog animates out.
  const [shown, setShown] = useState<PendingQuestion | null>(pending);
  if (pending && pending !== shown) setShown(pending);
  const stayed = useRef(false);
  useEffect(() => {
    if (pending) stayed.current = false;
  }, [pending]);

  const answer = (leave: boolean) => {
    stayed.current = !leave;
    answerLeaveQuestion(leave);
  };

  return (
    <Dialog open={!!pending} onOpenChange={open => { if (!open) answer(false); }}>
      {shown ? (
        <DialogContent
          className={styles.leaveDialog}
          title={shown.question.title}
          description={shown.question.description}
          onCloseAutoFocus={event => {
            // Staying: focus goes back to what started the navigation (the dialog has no trigger of its own).
            const target = shown.request.returnFocus;
            if (!stayed.current || !target?.isConnected) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
        >
          <div className={styles.leaveActions}>
            <Button variant="ghost" onClick={() => answer(false)}>{shown.question.stayLabel ?? "Stay"}</Button>
            <Button variant="danger" onClick={() => answer(true)}>{shown.question.leaveLabel ?? "Leave"}</Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
