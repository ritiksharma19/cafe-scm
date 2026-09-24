import type { SubmitPhase } from "@/lib/useRpcSubmit";

/** Error / unconfirmed banner shared by all stock forms. */
export function SubmitStatus({ phase }: { phase: SubmitPhase }) {
  if (phase.kind === "unconfirmed") {
    return (
      <div role="alert" className="rounded-lg bg-warn/10 px-3 py-2 text-sm font-medium text-warn">
        Not confirmed yet — {phase.message} Tap <b>Retry</b>. It will not be recorded twice.
      </div>
    );
  }
  if (phase.kind === "error") {
    return (
      <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
        Not saved: {phase.message}
      </div>
    );
  }
  return null;
}

export function SuccessBanner({ text, onDone }: { text: string; onDone?: () => void }) {
  return (
    <div role="status" className="flex items-center justify-between gap-3 rounded-xl bg-ok px-4 py-3 text-brand-ink">
      <p className="font-bold">✓ {text}</p>
      {onDone && (
        <button type="button" onClick={onDone} className="text-sm font-semibold underline">
          OK
        </button>
      )}
    </div>
  );
}
