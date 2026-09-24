import Link from "next/link";
import { SignOutButton } from "@/components/SignOutButton";
import { requireRole } from "@/lib/auth";

export const metadata = { title: "More" };

export default async function MorePage() {
  const { profile, location } = await requireRole("worker");

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-5">
        <p className="text-sm text-muted">Signed in as</p>
        <p className="text-lg font-bold">{profile.full_name}</p>
        <p className="text-sm text-muted">
          @{profile.username} · {location?.name}
        </p>
      </section>
      <section className="card divide-y divide-line">
        {[
          ["/worker/activity", "Today's activity"],
          ["/worker/sync", "Waiting to sync"],
          ["/worker/requests", "Request stock"],
          ["/worker/send", "Send stock to another location"],
          ["/worker/stock/count", "Count stock"],
        ].map(([href, label]) => (
          <Link key={href} href={href} className="flex min-h-14 items-center justify-between p-4 font-semibold">
            {label} <span aria-hidden>›</span>
          </Link>
        ))}
      </section>
      <SignOutButton className="btn btn-secondary w-full" checkOutbox />
    </div>
  );
}
