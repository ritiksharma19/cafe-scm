// Hand-maintained row types for the tables the UI reads.
// Once a Supabase project is linked, `npm run db:types` generates full types.

export type UserRole = "admin" | "worker";
export type LocationType = "central" | "cart";

export interface Location {
  id: string;
  code: string;
  name: string;
  type: LocationType;
  sort_order: number;
  is_active: boolean;
}

export interface Profile {
  id: string;
  username: string;
  full_name: string;
  role: UserRole;
  location_id: string | null;
  business_id: string;
  is_active: boolean;
  created_at: string;
}

/** The signed-in user's business (from current_business()). */
export interface Business {
  id: string;
  code: string;
  name: string;
  status: "active" | "suspended";
  plan: string;
  cart_limit: number | null;
  is_platform_admin: boolean;
}
