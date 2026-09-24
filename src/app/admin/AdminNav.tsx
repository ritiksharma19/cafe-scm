"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Sections are added here as each phase ships.
const LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/users", label: "Users" },
] as const;

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin" className="overflow-x-auto">
      <ul className="flex gap-1 px-3 pb-2 md:flex-col md:px-3 md:pb-0">
        {LINKS.map((link) => {
          const active = link.href === "/admin" ? pathname === "/admin" : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold ${
                  active ? "bg-brand/10 text-brand" : "text-muted hover:bg-bg hover:text-ink"
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
