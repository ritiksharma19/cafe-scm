import { redirect } from "next/navigation";
import { getCurrentUser, homePathFor } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(homePathFor(user.profile.role));

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-4 py-10">
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-brand text-lg font-extrabold text-brand-ink">
          SCM
        </div>
        <h1 className="text-2xl font-bold">Cafe SCM</h1>
        <p className="mt-1 text-muted">Sign in with your username and PIN</p>
      </div>
      <LoginForm />
    </main>
  );
}
