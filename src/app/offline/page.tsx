export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-bold">You are offline</h1>
      <p className="text-muted">This page has not been saved on this phone yet. Reconnect and try again.</p>
    </main>
  );
}
