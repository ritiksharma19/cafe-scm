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

/** Green = the server has it. Amber = saved on this phone, will sync when online. */
export function SuccessBanner({ text, onDone, queued = false }: { text: string; onDone?: () => void; queued?: boolean }) {
  return (
    <div role="status" className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-brand-ink ${queued ? "bg-warn" : "bg-ok"}`}>
      <p className="font-bold">✓ {text}</p>
      {onDone && (
        <button type="button" onClick={onDone} className="text-sm font-semibold underline">
          OK
        </button>
      )}
    </div>
  );
}
