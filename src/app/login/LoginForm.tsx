"use client";

import { useActionState, useEffect, useState } from "react";
import { signIn, type SignInState } from "@/app/actions/auth";

const CODE_KEY = "cafe-scm:business-code";

export function LoginForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, {});
  // The cafe code is typed once per phone and remembered; daily login is username + PIN.
  const [code, setCode] = useState("");
  const [editCode, setEditCode] = useState(true);

  useEffect(() => {
    let saved = "";
    try {
      saved = localStorage.getItem(CODE_KEY) ?? "";
    } catch {
      // storage blocked: the field simply stays visible
    }
    if (saved) {
      setCode(saved); // eslint-disable-line react-hooks/set-state-in-effect -- read once from device storage
      setEditCode(false);
    }
  }, []);

  function remember(fd: FormData) {
    const value = String(fd.get("code") ?? "").trim().toUpperCase();
    try {
      if (value) localStorage.setItem(CODE_KEY, value);
    } catch {
      // not fatal
    }
    return action(fd);
  }

  return (
    <form action={remember} className="card flex flex-col gap-4 p-5">
      {editCode ? (
        <div>
          <label htmlFor="code" className="mb-1.5 block text-sm font-medium">
            Cafe code
          </label>
          <input
            id="code"
            name="code"
            className="field uppercase tracking-wider"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. CHAIPOINT"
            maxLength={16}
          />
          <p className="mt-1 text-xs text-muted">Ask the owner. This phone remembers it.</p>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-xl bg-bg px-3 py-2 text-sm">
          <span>
            Cafe <b className="tracking-wider">{code}</b>
          </span>
          <input type="hidden" name="code" value={code} />
          <button type="button" onClick={() => setEditCode(true)} className="font-semibold text-brand">
            Change
          </button>
        </div>
      )}
      <div>
        <label htmlFor="username" className="mb-1.5 block text-sm font-medium">
          Username <span className="font-normal text-muted">(or owner email)</span>
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
