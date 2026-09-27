import { ConnectionStatus } from "@/components/ConnectionStatus";
import { SignOutButton } from "@/components/SignOutButton";
import { requireRole } from "@/lib/auth";
import { AdminNav } from "./AdminNav";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const { profile, business } = await requireRole("admin");

  return (
    <div className="flex flex-1 flex-col md:flex-row">
      {/* Desktop: full-height sidebar; the menu scrolls inside it and Sign out stays at the bottom. */}
      <aside className="border-b border-line bg-surface md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:shrink-0 md:flex-col md:border-b-0 md:border-r">
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] md:py-4">
          <div>
            <p className="text-lg font-extrabold leading-tight">{business.name}</p>
            <p className="text-xs text-muted">{profile.full_name} · Admin</p>
          </div>
          <ConnectionStatus />
        </div>
        <AdminNav platform={business.is_platform_admin} />
        <div className="hidden shrink-0 border-t border-line px-4 py-3 md:block">
          <SignOutButton className="btn btn-secondary w-full" />
        </div>
      </aside>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 md:px-8 md:py-8">{children}</main>
      <div className="px-4 pb-8 md:hidden">
        <SignOutButton className="btn btn-secondary w-full" />
      </div>
    </div>
  );
}
