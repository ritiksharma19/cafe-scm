"use client";

import { useActionState } from "react";
import type { Location, Profile } from "@/lib/types";
import { createWorker, resetPin, updateWorker, type ActionResult } from "./actions";

function Feedback({ state }: { state: ActionResult }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p role="status" className="rounded-lg bg-ok/10 px-3 py-2 text-sm font-medium text-ok">
        {state.ok}
      </p>
    );
  }
  return null;
}

function CartSelect({ carts, defaultValue }: { carts: Location[]; defaultValue?: string | null }) {
  return (
    <select name="location_id" className="field" defaultValue={defaultValue ?? ""} required>
      <option value="" disabled>
        Choose cart…
      </option>
      {carts.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function PinInput() {
  return (
    <input
      name="pin"
      className="field tracking-widest"
      inputMode="numeric"
      pattern="\d{6}"
      maxLength={6}
      minLength={6}
      autoComplete="new-password"
      placeholder="6 digits"
      required
    />
  );
}

export function CreateWorkerForm({ carts }: { carts: Location[] }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(createWorker, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Name</span>
          <input name="full_name" className="field" required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Username</span>
          <input name="username" className="field" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Cart</span>
          <CartSelect carts={carts} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">PIN</span>
          <PinInput />
        </label>
      </div>
      <Feedback state={state} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create worker"}
        </button>
      </div>
    </form>
  );
}

export function EditWorkerForm({ profile, carts }: { profile: Profile; carts: Location[] }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(updateWorker, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="user_id" value={profile.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Name</span>
          <input name="full_name" className="field" defaultValue={profile.full_name} required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Cart</span>
          <CartSelect carts={carts} defaultValue={profile.location_id} />
        </label>
      </div>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="is_active" defaultChecked={profile.is_active} className="size-5 accent-brand" />
        <span className="font-medium">Active (can sign in)</span>
      </label>
      <Feedback state={state} />
      <div>
        <button type="submit" className="btn btn-secondary" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

export function ResetPinForm({ userId }: { userId: string }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(resetPin, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="user_id" value={userId} />
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">New PIN</span>
        <PinInput />
      </label>
      <Feedback state={state} />
      <div>
        <button type="submit" className="btn btn-secondary" disabled={pending}>
          {pending ? "Updating…" : "Reset PIN"}
        </button>
      </div>
    </form>
  );
}
