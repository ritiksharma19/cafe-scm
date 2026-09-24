"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "@/app/actions/auth";

export function LoginForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, {});

  return (
    <form action={action} className="card flex flex-col gap-4 p-5">
      <div>
        <label htmlFor="username" className="mb-1.5 block text-sm font-medium">
          Username <span className="font-normal text-muted">(or email)</span>
        </label>
        <input
          id="username"
          name="username"
          className="field"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={state.username}
          required
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          PIN / password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="field tracking-widest"
          autoComplete="current-password"
          required
        />
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
