import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Cafe SCM", template: "%s · Cafe SCM" },
  description: "Internal stock and supply-chain app for the carts.",
  applicationName: "Cafe SCM",
  appleWebApp: { capable: true, title: "Cafe SCM", statusBarStyle: "default" },
  icons: { apple: "/pwa-icon/180" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0f5132",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
