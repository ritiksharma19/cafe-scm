import Link from "next/link";
import { SyncList } from "./SyncList";

export const metadata = { title: "Sync" };

export default function SyncPage() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Waiting to sync</h1>
        <Link href="/worker/more" className="text-sm font-semibold text-brand">
          Back
        </Link>
      </div>
      <p className="text-sm text-muted">
        Everything here is saved on this phone. It is sent automatically when there is a connection, and it can never be
        counted twice.
      </p>
      <SyncList />
    </div>
  );
}
