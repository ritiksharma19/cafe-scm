"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/worker", label: "Sell", icon: "M3 3h2l.4 2M7 13h10l4-8H5.4M7 13 5.4 5M7 13l-2.3 2.3c-.6.6-.2 1.7.7 1.7H17m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-8 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" },
  { href: "/worker/receive", label: "Receive", icon: "M20 7 12 3 4 7m16 0-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
  { href: "/worker/waste", label: "Waste", icon: "M19 7l-.9 12.1A2 2 0 0 1 16.1 21H7.9a2 2 0 0 1-2-1.9L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" },
  { href: "/worker/stock", label: "Stock", icon: "M4 6h16M4 12h16M4 18h16" },
  { href: "/worker/more", label: "More", icon: "M5 12h.01M12 12h.01M19 12h.01" },
] as const;

export function WorkerNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Worker"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto grid max-w-md grid-cols-5">
        {TABS.map((tab) => {
          const active = tab.href === "/worker" ? pathname === "/worker" : pathname.startsWith(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-semibold ${
                  active ? "text-brand" : "text-muted"
                }`}
              >
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className="size-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={active ? 2.25 : 1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={tab.icon} />
                </svg>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
