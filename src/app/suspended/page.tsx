import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/SignOutButton";
import { getCurrentUser, homePathFor } from "@/lib/auth";

export const metadata = { title: "Account suspended" };

export default async function SuspendedPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.business.status === "active") redirect(homePathFor(user.profile.role));

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-5 px-4 py-10 text-center">
      <h1 className="text-2xl font-bold">{user.business.name} is paused</h1>
      <p className="text-muted">
        This business account is suspended, so the app cannot be used for now. Nothing has been deleted — everything is back as soon as
        the account is reactivated. Please contact support.
      </p>
      <SignOutButton className="btn btn-secondary w-full" />
    </main>
  );
}
