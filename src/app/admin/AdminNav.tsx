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
      { href: "/admin/reports", label: "Reports & export" },
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
      { href: "/admin/expenses", label: "Expenses" },
      { href: "/admin/counts", label: "Stock counts" },
    ],
  },
  {
    title: "Setup",
    links: [
      { href: "/admin/products", label: "Products & recipes" },
      { href: "/admin/addons", label: "Add-ons" },
      { href: "/admin/import", label: "Import from Excel" },
      { href: "/admin/materials", label: "Raw materials" },
      { href: "/admin/suppliers", label: "Suppliers" },
      { href: "/admin/locations", label: "Carts & locations" },
      { href: "/admin/users", label: "Users" },
      { href: "/admin/settings", label: "Settings" },
    ],
  },
] as const;

export function AdminNav({ platform = false }: { platform?: boolean }) {
  const pathname = usePathname();
  // The product owner also sees the Platform section (all businesses).
  const groups = platform
    ? [...GROUPS, { title: "Platform", links: [{ href: "/admin/platform", label: "Businesses" }] }]
    : GROUPS;

  return (
    <nav aria-label="Admin" className="overflow-x-auto md:min-h-0 md:flex-1 md:overflow-y-auto md:overflow-x-hidden">
      <div className="flex gap-1 px-3 pb-2 md:flex-col md:gap-3 md:pb-3">
        {groups.map((g) => (
          <div key={g.title} className="flex gap-1 md:flex-col md:gap-0.5">
            <p className="hidden px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted md:block">{g.title}</p>
            {g.links.map((link) => {
              const active = link.href === "/admin" ? pathname === "/admin" : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-10 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold md:min-h-9 ${
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
