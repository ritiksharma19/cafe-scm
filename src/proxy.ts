import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, the service worker, manifest and PWA icons.
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|pwa-icon|.*\.(?:png|svg|jpg|jpeg|webp|ico)$).*)",
  ],
};
