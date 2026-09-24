import { ConnectionStatus } from "@/components/ConnectionStatus";
import { requireRole } from "@/lib/auth";
import { WorkerNav } from "./WorkerNav";

export default async function WorkerLayout({ children }: LayoutProps<"/worker">) {
  const { profile, location } = await requireRole("worker");

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="min-w-0">
          <p className="truncate text-lg font-bold leading-tight">{location?.name ?? "No cart assigned"}</p>
          <p className="truncate text-xs text-muted">{profile.full_name}</p>
        </div>
        <ConnectionStatus />
      </header>
      <main className="flex-1 px-4 pb-28 pt-4">{children}</main>
      <WorkerNav />
    </div>
  );
}
