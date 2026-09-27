# Create a new customer (business) and its admin

Every customer (cafe / restaurant) is a separate **business** with its own **cafe code**,
data, carts and logins. There are two ways to create one.

---

## Option A — from the command line (one command)

Run in the project folder (`Cafe_SCM`). Needs `.env.local` with `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SECRET_KEY` and `LOGIN_EMAIL_DOMAIN`.

```bash
npm run create-admin -- <CAFECODE> <admin-username-or-email> "<Admin Full Name>"
```

Example — new customer "Chai Point" with owner Ravi Kumar:

```bash
npm run create-admin -- CHAIPOINT ravi "Ravi Kumar"
```

It asks for the admin's password twice (min 8 characters, hidden).

What it does:

- If no business has the code `CHAIPOINT`, it **creates the business** with Central Storage and Cart 1
  (the business name starts as the code; the owner renames it in **Settings**).
- If the code already exists, it **adds another admin** to that business.
- Creates the admin login. The admin signs in with **cafe code `CHAIPOINT`**, username **`ravi`** and the password.

Rules:

| Field | Rule |
|---|---|
| Cafe code | 3–16 letters or digits (e.g. `CHAIPOINT`, `CAFE22`). Unique across all customers. |
| Username | 2–32 lower-case letters, digits, `.` `_` `-`. Unique within the business. |
| Email instead of username | Allowed (e.g. `ravi@gmail.com`); the admin then signs in with the email, no cafe code needed. |
| Password | At least 8 characters. |

### Without the password prompt (e.g. scripts)

PowerShell:

```powershell
$env:ADMIN_PASSWORD = "S3curePass!"; npm run create-admin -- CHAIPOINT ravi "Ravi Kumar"; Remove-Item Env:ADMIN_PASSWORD
```

Git Bash / macOS / Linux:

```bash
ADMIN_PASSWORD='S3curePass!' npm run create-admin -- CHAIPOINT ravi "Ravi Kumar"
```

### Optional — load the sample menu into the new business

```bash
npm run seed:sample -- ravi CHAIPOINT
```

(Admin username, then cafe code. Asks for the admin's password. Safe to run more than once.)

### Optional — 30 days of demo data for a tea-stall chain (for client demos)

```bash
npm run seed:demo -- CHAIPOINT ravi
```

(Cafe code, then the business's admin username. Needs the Supabase CLI linked, like `npm run db:push`.)
Fills the business with a month of realistic activity: chai / coffee / snacks menu with sizes and add-ons,
5 suppliers, daily milk & bakery deliveries, weekly restocks with price changes, 3 carts, ~3,500 orders
(cash / UPI / card, add-ons, discounts, a few voids), transfers, wastage, expenses, weekly stock counts and
stock requests — plus open items for today (a count to approve, a pending request, a transfer on the way).
Workers: `arjun` 111111 and `neha` 444444 (Cart 1), `priya` 222222 (Cart 2), `sameer` 333333 (Cart 3).
The history is only added once (skipped if the business already has orders).

---

## Option B — from the app (no command line)

Signed in as the platform admin (currently `hitesh`):

1. Open **Admin → Platform → Businesses**.
2. Under **New business** fill in: business name, cafe code, plan, carts to start with,
   cart limit (blank = unlimited), and the owner's name, username and password.
3. Click **Create business**.

On the same page you can later rename a business, change its code, plan or cart limit,
**suspend** it (e.g. unpaid — its users are blocked, nothing is deleted), reactivate it,
or **Add an owner login**.

> Plan and cart limit can only be set here (Option A creates the business without a limit).

---

## After creating — tell the customer

1. Open the app link and sign in with: **cafe code**, **username**, **password**.
2. **Settings** → set the business name.
3. **Carts & locations** → rename / add carts.
4. **Users** → add workers (each gets a username and 6-digit PIN; they sign in with the same cafe code).
5. **Import from Excel** or **Products & recipes** → set up the menu; **Raw materials** → costs and stock levels.

The cafe code is shown to the owner in **Settings** and **Users**.
Demo logins (cafe code CHAIPOINT):
- Owner: ravi, with your password
- Worker arjun, PIN 111111 (Cart 1)
- Worker neha, PIN 444444 (Cart 1)
- Worker priya, PIN 222222 (Cart 2)
- Worker sameer, PIN 333333 (Cart 3)