"use client";

import { useActionState } from "react";
import type { ActionState } from "@/app/admin/stock-actions";
import { addOwner, createBusiness, updateBusiness } from "./actions";

function Status({ state }: { state: ActionState }) {
  if (state.error) return <p className="w-full text-sm font-medium text-danger">{state.error}</p>;
  if (state.ok) return <p className="w-full text-sm font-medium text-ok">{state.ok}</p>;
  return null;
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function OwnerFields() {
  return (
    <>
      <Field label="Owner name">
        <input name="owner_name" className="field" required />
      </Field>
      <Field label="Owner username">
        <input name="owner_username" className="field" autoCapitalize="none" placeholder="e.g. owner" required />
      </Field>
      <Field label="Owner password (min 8)">
        <input name="owner_password" type="password" minLength={8} className="field" autoComplete="new-password" required />
      </Field>
    </>
  );
}

export function CreateBusinessForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createBusiness, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Business name" className="lg:col-span-2">
        <input name="name" className="field" maxLength={60} required />
      </Field>
      <Field label="Cafe code (login)">
        <input name="code" className="field uppercase tracking-wider" maxLength={16} placeholder="CHAIPOINT" required />
      </Field>
      <Field label="Plan">
        <input name="plan" className="field" defaultValue="standard" />
      </Field>
      <Field label="Carts to start with">
        <input name="carts" type="number" min={0} max={50} defaultValue={1} className="field" />
      </Field>
      <Field label="Cart limit (blank = unlimited)">
        <input name="cart_limit" type="number" min={1} className="field" />
      </Field>
      <OwnerFields />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Creating…" : "Create business"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export interface PlatformBusiness {
  id: string;
  code: string;
  name: string;
  status: "active" | "suspended";
  plan: string;
  cart_limit: number | null;
  notes: string | null;
}

export function EditBusinessForm({ business, own }: { business: PlatformBusiness; own: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateBusiness, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <input type="hidden" name="id" value={business.id} />
      <Field label="Name" className="lg:col-span-2">
        <input name="name" defaultValue={business.name} className="field" maxLength={60} required />
      </Field>
      <Field label="Cafe code">
        <input name="code" defaultValue={business.code} className="field uppercase tracking-wider" maxLength={16} required />
      </Field>
      <Field label="Plan">
        <input name="plan" defaultValue={business.plan} className="field" />
      </Field>
      <Field label="Cart limit">
        <input name="cart_limit" type="number" min={1} defaultValue={business.cart_limit ?? ""} className="field" placeholder="∞" />
      </Field>
      <Field label="Notes (billing, contact…)" className="sm:col-span-2 lg:col-span-4">
        <input name="notes" defaultValue={business.notes ?? ""} className="field" maxLength={300} />
      </Field>
      <label className="flex min-h-12 items-center gap-2 self-end">
        <input type="checkbox" name="suspended" defaultChecked={business.status === "suspended"} disabled={own} className="size-5 accent-danger" />
        <span className="text-sm font-medium">{own ? "Your business" : "Suspended"}</span>
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-5">
        <button type="submit" disabled={pending} className="btn btn-secondary">
          {pending ? "Saving…" : "Save"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function AddOwnerForm({ businessId }: { businessId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addOwner, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="business_id" value={businessId} />
      <OwnerFields />
      <div className="flex items-end">
        <button type="submit" disabled={pending} className="btn btn-secondary w-full">
          {pending ? "Adding…" : "Add owner login"}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}
