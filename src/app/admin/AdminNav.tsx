"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const GROUPS = [
  {
    title: "Overview",
    links: [
      { href: "/admin", label: "Dashboard" },
      { href: "/admin/inventory", label: "Inventory" },
      { href: "/admin/analytics", label: "Analytics" },
    ],
  },
  {
    title: "Operations",
    links: [
      { href: "/admin/orders", label: "Orders" },
      { href: "/admin/requests", label: "Requests" },
      { href: "/admin/transfers", label: "Transfers" },
      { href: "/admin/purchases", label: "Purchases" },
      { href: "/admin/wastage", label: "Wastage" },
      { href: "/admin/counts", label: "Stock counts" },
    ],
  },
  {
    title: "Setup",
    links: [
      { href: "/admin/products", label: "Products & recipes" },
      { href: "/admin/materials", label: "Raw materials" },
      { href: "/admin/suppliers", label: "Suppliers" },
      { href: "/admin/users", label: "Users" },
      { href: "/admin/settings", label: "Settings" },
    ],
  },
] as const;

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin" className="overflow-x-auto md:overflow-y-auto">
      <div className="flex gap-1 px-3 pb-2 md:flex-col md:gap-4 md:pb-4">
        {GROUPS.map((g) => (
          <div key={g.title} className="flex gap-1 md:flex-col">
            <p className="hidden px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted md:block">{g.title}</p>
            {g.links.map((link) => {
              const active = link.href === "/admin" ? pathname === "/admin" : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-10 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold ${
                    active ? "bg-brand/10 text-brand" : "text-muted hover:bg-bg hover:text-ink"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
