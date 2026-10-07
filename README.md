# Vasantham Rewards & Customer Ecosystem — V1.5

A Vasantham-led loyalty ecosystem. Customers earn points at Vasantham and use them, along with coupons and unlocked rewards, at Vasantham and at participating businesses (House of Friez, Afya Mart, MF Nuts, and any partner added later). One central backend serves three web interfaces.

| Interface | URL | Who uses it |
|---|---|---|
| **Customer App** (mobile-first web app) | `/customer` | Customers: points, ₹ value, QR, Rewards Marketplace, coupons, purchases, savings, redemption QR |
| **Manager Panel** | `/manager` | Outlet managers of any business: scan/search, apply that business's rules, approve redemptions, print slips, confirm partner bills, daily report |
| **Admin Panel** | `/admin` | Head office: businesses/partners, Excel upload, CRM, offers and rewards, campaigns, segments, reconciliation, settlement, analytics, liability, audit |

**V1.5 status:** all three phases are built:
- the multi-business ecosystem ([Phase 1](#ecosystem-v15-phase-1))
- engagement: milestones, visit challenges, reactivation, referrals and targeting ([Phase 2](#engagement-v15-phase-2))
- the growth analytics dashboard and role-based access ([Phase 3](#growth--roles-v15-phase-3))

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there are no native modules to compile).

Run these from the main `vasantham-loyalty` folder (they call into `backend/`):

```bash
npm run install-all # installs backend and Android app dependencies
npm run seed        # branches, the 4 businesses with their rules, partner outlets, logins, sample offers and rewards
npm run demo        # DEMO DATABASES ONLY: ~150 sample customers, redemptions, one login per role, and switches on the seeded challenges + referral programme
npm start           # http://localhost:4000
```

`npm run seed` and `npm run demo` are safe to re-run. The seed creates the Phase 2 challenges, referral programme and reactivation automations **switched off**, so nothing is given to real customers until an admin reviews and activates them. Don't run `npm run demo` on the live database: it imports sample customers and bills. On an existing database, starting the server adds the new tables and attaches all existing branches, offers and redemptions to Vasantham; run `npm run seed` once to add the three partner businesses.

Default logins (change them before going live, or set `ADMIN_PASSWORD` / `MANAGER_PASSWORD` before seeding):

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `Admin@12345` |
| Manager, Anna Nagar | `ann.manager` | `Manager@123` |
| Manager, T. Nagar | `tnr.manager` | `Manager@123` |
| Manager, Velachery | `vel.manager` | `Manager@123` |
| Manager, House of Friez (Anna Nagar) | `hof.manager` | `Manager@123` |
| Manager, Afya Mart (T. Nagar) | `afya.manager` | `Manager@123` |
| Manager, MF Nuts (Velachery) | `mfn.manager` | `Manager@123` |

`npm run demo` also creates one login per Phase 3 role, password `Demo@12345`: `vasantham.admin` (Vasantham Admin), `hof.owner` (Business Owner, House of Friez), `reports` (Reporting), `hof.cashier` (Redemption Manager at the HOF outlet). The seed never creates these, so a live database doesn't get extra accounts with a known password.

**Demo data:** `npm run sample` writes `backend/samples/sample-pos-export.xlsx`: 90 days of item-level bills for 3 branches, about 150 customers, walk-ins and a few returns. Upload it in **Admin → Excel upload**, then log in to the Customer App with, for example, `9840000000`.

**OTP in development:** there is no SMS gateway yet, so OTPs are printed on the server console and shown on screen as "Demo mode". Set `DEV_OTP=0` in production and connect a gateway in `sendSms()` ([backend/src/auth.js](backend/src/auth.js)).

Run the tests with `npm test` (33 end-to-end tests). They cover the points math, Excel import, the redemption lifecycle, OTP and ticket security, reconciliation, returns, campaigns and analytics. [backend/test/ecosystem.test.js](backend/test/ecosystem.test.js) runs the full cross-business journey end to end: earn at Vasantham → marketplace → redeem at House of Friez within its 20% rule → receipt → partner bill confirmation → settlement → reversal. [backend/test/engagement.test.js](backend/test/engagement.test.js) covers milestones, visit challenges, referrals and their fraud checks, reactivation and targeting. [backend/test/growth-roles.test.js](backend/test/growth-roles.test.js) checks the growth figures on a known dataset and what each role can and cannot do.

## Business rules implemented

- **Earning:** points = eligible net bill value (after discounts) ÷ 200, **truncated** to 2 decimals. For example, ₹1,125 gives 5.625, which is credited as **5.62**. The exact value is stored per bill in `purchases.raw_points`. Balances are kept as integer centipoints, so no floating-point drift is possible.
- **Two upload types:** on **Admin → Excel upload**, choose **From bill amount** (points calculated by the rule above, plus automatic bonus / multiplier offers) or **Points given in file** (the POS file has a **Points** column per bill, credited exactly as given, truncated to 2 decimals, with no automatic offers added). In points mode the amount column is optional, a member bill with a blank Points cell is rejected (use 0 for no points), and a RETURN row's Points are taken back, never more than the original bill earned. Each mode has its own downloadable template, and Upload history shows which mode each file used.
- **Value:** 1 point = ₹2. For example, 5.62 points = ₹11.24.
- **Returns:** reverse the proportional share of the points the original bill earned, bonuses included. **Cancelled bills** reverse all remaining points of the original bill.
- **Promotions:** *bonus points* and *multiple points* offers are applied automatically when bills are imported. Multipliers don't stack; the best one wins. All other offer types are redeemed through a manager.
- **Enrolment without the app:** a bill with a new mobile number creates a basic account. When that customer later logs in with the same mobile number, their history and points are already there.
- **App profile:** on first login a customer must enter their name and at least one of **date of birth** or **wedding anniversary**. Once saved, a date can only be changed by the store (Admin → customer page), because it drives rewards.
- **Stores & customer care:** each branch's address, phone, WhatsApp and Google Maps link are set in **Admin → Branches & staff → Edit**. The customer care number, WhatsApp, email and hours are set in **Admin → Settings**. The Customer App shows them under **Account → Stores & customer care** and on the Home screen. Tapping a number opens the phone's dialer, WhatsApp opens a chat (for customer care, a complaint message with the member ID is pre-filled), and Directions opens Google Maps.
- **Offer images & PDFs:** any offer or campaign can have one image (JPG, PNG, WebP) or PDF of up to 10 MB, added in **Admin → Offers → New/Edit** or the campaign form. Customers see images on the offer card (tap to enlarge) and a **View offer (PDF)** button for PDFs. The same image or PDF appears in the notification sent when a personalised offer or campaign is assigned. For offers for everyone, **Send to app** notifies every customer who uses the app, within the daily notification limit. Files are stored in `backend/data/uploads/offers/`, so include that folder in backups.

## Ecosystem (V1.5, Phase 1)

### Businesses / Partners
**Admin → Businesses / Partners** lists every business. Nothing is hard-coded: the four launch businesses are seed data, and a new partner is added the same way. Each business has:

- name, code, logo, category, marketplace line, display order, active / inactive
- **Can earn points** and **Can redeem points** switches
- **Takes part in offers / coupons** switch
- how bills are confirmed: **Excel upload** (Vasantham) or **manager confirms in the Manager Panel** (partners without a POS feed)
- redemption rules (below), with eligible outlets
- settlement cycle (weekly / monthly / custom) and account details
- contact details, customer-facing terms, internal notes

Outlets are ordinary branches linked to a business (**Admin → Branches & staff**). A manager's business comes from their outlet, so a House of Friez manager only sees House of Friez rules and rewards.

Launch configuration (from the seed):

| Business | Earn | Redeem | Rule |
|---|---|---|---|
| Vasantham Super Mart | Yes | Yes | No limit (configurable) |
| House of Friez | No | Yes | Up to 20% of the bill |
| Afya Mart | No | Yes | Up to 15% of the bill |
| MF Nuts | No | Yes | Up to 25% of the bill, max ₹150, minimum bill ₹300 |

### Earning
Points are earned only at businesses with **Can earn points** switched on. A bill uploaded for an outlet of a non-earning business is recorded for history and analytics but credits no points (the upload result shows a warning). Returns at such outlets reverse nothing.

### Redemption rules
Each business has one current policy, validated **on the server** when a redemption is requested and again, in full, when a manager approves it:

- **Limit type:** no limit, % of the bill, maximum ₹ per redemption, or % of the bill up to a maximum ₹
- **Minimum bill** and **minimum points**
- **Eligible outlets** (none selected = all outlets of the business)

Worked example: the customer has ₹300 of points and a ₹500 House of Friez bill with a 20% limit. The manager enters the bill, the panel shows "Approving 50 of 150 points (₹100)", and only 50 points are deducted; the other 100 stay in the balance. The server rejects anything above the cap, anything below the minimum bill, and any attempt to approve more points than the customer requested.

A redemption QR is created for one business. It can only be approved at an outlet of that business, once, within 10 minutes. The global min/max points settings still apply on top of each business's rules.

### Two kinds of rewards
- **Points redemption rewards** use points: either any amount of points as a ₹ discount (within the business rules), or a catalogue reward with **Points needed** (e.g. "Burger combo for 60 points").
- **Promotional unlock rewards / coupons** need no points (Points needed = 0): e.g. free fries at HOF, ₹50 off at MF Nuts, a free product at Afya Mart, birthday and comeback rewards. Personalised ones are unlocked for customers by assignment or campaign and appear under **My coupons & unlocked rewards**.

Every offer belongs to a business, has a customer-facing **value** and an optional **internal cost** (a ₹99 fries reward can cost ₹35), and a **funding** setting:

| Funding | Who pays the cost |
|---|---|
| Vasantham loyalty fund | the fund pays the redeeming business the full cost |
| Partner business | the funding partner pays; if it is also the redeeming business, nothing is settled |
| Shared | the partner pays a fixed ₹ share, the fund pays the rest |

Bonus / multiplier (earning) offers can only belong to a business that earns points.

### Rewards Marketplace (Customer App → Rewards)
Shows the balance, **My coupons & unlocked rewards**, then one card per business that accepts redemption, with its logo, marketplace line, how much of the balance can be used there, and its % limit. A business page lists the rules, minimum bill, maximum redemption, rewards (points needed, value, minimum bill, validity, terms), and a **Redeem points here** button that creates a one-time QR for that business.

### Manager Panel
The header shows the manager's business and outlet. Scanning a customer shows the balance and ₹ value, the business's rules, what can be redeemed here, and only this business's rewards and coupons. A bill-amount field drives the live maximum. Managers cannot issue points: points only come from the Excel upload and admin adjustments.

Outlets that confirm bills in the panel open the receipt and use **Confirm bill** (bill number + final amount). That completes the redemption (BILLED → RECONCILED) and makes it settleable.

### Redemption receipt
Shows the redemption ID, customer (masked mobile), business, outlet, manager, redemption type, points redeemed, ₹ value, coupon/offer, minimum bill, bill amount, timestamp and status. It is one-time-use (the token is destroyed on approval), and every step is in the redemption history and the audit log.

### Cross-business settlement (Admin → Settlements)
Every approved redemption writes settlement lines:

- **Payable:** the loyalty fund owes the redeeming business the fund-funded amount (points value, or the reward cost funded by the fund / a different partner).
- **Receivable:** a partner that funds a reward used at another business owes the fund its share.

Example: a customer redeems ₹100 of points at HOF → payable ₹100 to HOF ("the Vasantham loyalty account owes HOF ₹100"). Vasantham's own redemptions get their own lines too, so the fund and each business stay accounted separately.

The report (this / last week, this / last month, custom) shows, per business: redemptions, points used, reward value, promotional reward cost (fund / partner), payable, receivable, net, settled, awaiting billing, ready to settle. **Create settlement** batches the billing-confirmed lines for the period; **Mark settled** records the amount and payment reference; an open settlement can be voided. Lines are append-only: a reversal adds negative lines, so a settled period is never rewritten and the correction lands in the next settlement.

### Data model
Tables added in V1.5 (SQLite now; the schema maps directly onto PostgreSQL):

| Spec entity | Table |
|---|---|
| businesses | `businesses` |
| business_redemption_rules | `business_redemption_rules` |
| branches / outlets | `branches.business_id` |
| offers, coupons, promotional_rewards | `offers` (+ `business_id`, `points_cost_cp`, `cost_paise`, `funding_type`, `funder_business_id`, `partner_share_paise`, `terms`) |
| unlocked coupons per customer | `offer_assignments` |
| redemptions, redemption_receipts | `redemptions` (+ `business_id`, `bill_paise`, funding split, `partner_bill_no`) + `redemption_events` |
| settlements, settlement_transactions | `settlements`, `settlement_transactions` |
| points_ledger / points_balance | `points_ledger`, `customers.balance_cp` |
| excel_imports, reconciliation_records, audit_logs | `imports`, `recon_issues`, `audit_logs` |

Phase 2 tables: `challenges` + `challenge_tiers` (spec: milestones, visit_challenges), `customer_challenge_progress`, `challenge_awards`, `automations` + `automation_targets` (reactivation), `referral_programs` + `referrals`, `interest_segments`; plus `offer_assignments.uses_allowed` / `source`, `offers.target_segments` and `customers.referral_code`.

Phase 3: `customer_business_activity` (each customer's first / last activity, purchases, spend and redemptions per business, and how they first came: purchase or reward), plus `staff.access_role` and `staff.business_id`.

## Growth & roles (V1.5, Phase 3)

### Ecosystem growth dashboard (Admin → Ecosystem growth)
Choose a period (this / last week, this / last month, custom) and all businesses or one business. The dashboard shows:

- **Key metric: revenue associated with redemption ÷ reward value used.** The bills a reward was used on (Vasantham bills matched by the Excel upload, partner bills confirmed by the outlet), divided by the ₹ value of the points and rewards used. For example, ₹5,00,000 ÷ ₹50,000 = 10×. It is labelled as an operational efficiency measure, **not incremental revenue**: the customer may have bought anyway.
- **Customers:** loyalty customers, new members, app users, active customers (bought or redeemed), visits per shopper, spend per shopper, member revenue.
- **Redemptions & rewards:** redemptions, reward value used, reward cost (and the partner-funded part), average bill with a reward vs Vasantham bills without one, redemption rate, points redeemed ÷ earned, repeat rate after the first ecosystem redemption, Vasantham customers redeeming at other businesses, customers using 2+ businesses.
- **Engagement:** dormant customers recovered (bought again after longer than the "active" window), reactivation recovery, referral conversions, milestone and visit-challenge completion rates.
- **Trend:** the key ratio for the last 6 months, with a table view.
- **By business:** redemptions, customers, reward value and cost, revenue with a reward, average bill, the ratio, and **first-time customers**, including how many first came to that business to use a reward.
- **Cross-business movement:** for each partner, customers redeeming there, how many also shopped at Vasantham, and how many used another partner.
- **Challenges** and **campaign performance** for the period.

### Roles (Admin → Branches & staff)
| Role | Panel | Can do |
|---|---|---|
| Super Admin | Admin | Everything: businesses and rules, settlements, staff, settings |
| Vasantham Admin | Admin | Vasantham operations: uploads, customers and point adjustments, offers, campaigns, engagement, redemptions and reconciliation, reports. Not: businesses, settlement payments, staff, settings |
| Business Owner / Admin | Admin | **Own business only**: growth report, its offers (always funded by the business itself), its redemptions (masked mobiles), its settlements, and its public profile (marketplace line, contacts, terms, logo). No customer database or Vasantham-wide reports |
| Reporting User | Admin | Read-only reports; optionally limited to one business |
| Branch Manager | Manager | Own branch / outlet: scan, redeem, enrol customers, confirm bills, daily report |
| Redemption Manager | Manager | Redemption functions only: scan, approve, receipts, confirm bills. No enrolment or daily report |

- **Enforcement:** permissions are checked on the server for every Admin API route. The menus and buttons simply follow them.
- **Business-limited logins:** they get only their own business's data, and Vasantham-wide reports are refused.
- **Existing logins:** admins became Super Admins and managers became Branch Managers.
- **Lock-out protection:** there is always at least one active Super Admin, and you can't change your own role.

## Engagement (V1.5, Phase 2)

All of these run off the daily Excel upload. After each upload the system refreshes segments, then updates challenge progress and gives rewards, qualifies referrals, and runs reactivation automations. A nightly job expires referrals and runs automations again. Rewards are either **bonus points** or a **personalised offer / coupon at any business** (create it under Offers with Audience = Personalised). Each grant is one more use of that offer for that customer. Reward notifications always go through; they don't count towards the daily promotional cap.

### Spend milestones and visit challenges (Admin → Milestones & challenges)
- **Spend milestone:** net Vasantham spend in the period (sales minus returns) against tiered targets, e.g. ₹2,500 → 10 bonus points, ₹5,000 → ₹50 House of Friez reward, ₹7,500 → MF Nuts coupon, ₹10,000 → Afya Mart pack.
- **Visit challenge:** distinct days with a bill of at least the minimum, e.g. 4 visits a month with ₹300+ bills → 20 bonus points. Two bills on one day count as one visit.
- **Configurable:** measurement period (calendar month, Monday–Sunday week, or the whole campaign), eligible customers (any segment), participating branches, validity, and whether rewards can be earned again every period.
- **Rewards:** each tier is given once per period (or once ever if not repeatable), automatically after the upload that crosses the target. A late upload of last month's bills still completes last month. Rewards are not taken back if a later return brings the total below the target. Once any reward has been given, the type, period and tiers are locked; deactivate the challenge and create a new one to change them.
- **Customer App (Home → Challenges):** a progress bar ("₹6,400 / ₹7,500 · ₹1,100 more to unlock …") or visit ticks (✓ ✓ ✓ 4), days left, and every tier with its reward.
- **Admin reporting:** eligible customers, participants this period, completion rate (customers who reached a reward ÷ participants), and rewards given per tier.

### Reactivation (Admin → Reactivation)
An automation sends a personalised reward to everyone in a segment, e.g. **Overdue** → "We miss you: ₹75 off", or **Dormant** → ₹50 at House of Friez.
- **Segments:** Active, Regular, High-value, Overdue (new: well past their usual gap between visits; the factor is in Segmentation settings), Dormant, Lost, Spend decline, Frequency decline, and any interest segment.
- **Settings:** reward validity, a **cooldown** before the same customer can be targeted again, and a **recovery window**.
- **Preview** shows how many customers would get it now. **Run now** sends immediately; otherwise active automations run after each upload and nightly.
- **Performance:** targeted, recovered (a Vasantham purchase within the window after targeting), recovery rate, revenue from recovered customers in the window, reward redemptions and their cost.

### Referrals (Admin → Referrals, Customer App → Account → Refer a friend)
- **Customer App:** each customer gets a code (e.g. `VR3MTHUJ`) and a share link (`/customer?ref=CODE`, with a WhatsApp share button). A new customer enters the code when signing up (it is pre-filled from the link) or later on the Refer page.
- **Qualifying:** the referral is **pending** until the new customer's first Vasantham bill of at least the minimum, within the qualification window, arrives in an upload. Then the referrer gets their reward (e.g. 25 bonus points) and the new customer gets a welcome reward (e.g. free fries at House of Friez).
- **Configurable:** minimum qualifying purchase, both rewards, max referrals per customer, max per day, validity, qualification window, and how new the referee's account must be.
- **Fraud prevention:**
  - one account per mobile, verified by OTP
  - a customer can be referred only once, ever, and only if they have never purchased and joined recently
  - no self-referral and no A↔B loops
  - the referrer must be an active customer who has shopped
  - lifetime and daily caps per referrer
  - pending referrals expire
  - admins can reject a suspicious pending referral with a reason; everything is audited

### Cross-business targeting (Admin → Interest segments, Offers)
- **Interest segments** are rules management controls, not AI: categories and/or product-name keywords, a minimum share of the customer's basket, an optional minimum spend, and a look-back period. Seeded examples: nuts, seeds & health foods (→ MF Nuts), snacks, beverages & frozen (→ House of Friez), home & personal care (→ Afya Mart). They need item-level Excel data.
- **Showing offers to a segment:** an offer for everyone can be limited with **Show only to these segments**. Only customers in one of those segments see it in the app and at the counter (and only they earn bonus points from it). Interest segments can also target campaigns, challenges and reactivation.

## Daily workflow

```
Customer asks to redeem ──► App creates one-time QR (valid 10 min, value computed by server)
        │                         or manager finds customer (rotating QR / mobile + customer OTP)
        ▼
Manager scans ──► Approve ──► points deducted immediately (atomic, real-time, all branches)
        ▼
Redemption slip printed (VR-YYMMDD-NNNN) ──► cashier applies discount, types the ID in bill remarks / loyalty ref
        ▼
Next day: Admin uploads POS Excel ──► points credited · purchases/analytics updated · redemptions reconciled
```

Redemption statuses: `CREATED → APPROVED → SUBMITTED (to billing) → BILLED → RECONCILED`, plus `CANCELLED`, `EXPIRED` and `REVERSED`. Every cancellation or reversal requires a reason and is written to the audit log. A reversal after approval returns the points.

### Redemption security

- The customer's QR is **HMAC-signed and rotates every minute**. It is accepted for 15 minutes, so a shared screenshot quickly stops working.
- A redemption QR is a random **one-time token** that is invalidated on approval. The ₹ value always comes from the server, so the customer can't change it.
- Approval re-checks the balance inside a database transaction. The same points can't be approved twice, even at two branches at the same moment.
- If a manager finds a customer by mobile number, the customer must confirm with an **OTP** sent to their phone (configurable in Settings). Verification tickets are tied to the manager who obtained them.
- Every approval records the manager, branch and time. Managers can reverse only their own branch's redemptions; after billing, only an admin can.

## Excel upload format

Download the template from **Admin → Excel upload**. The first sheet is read. Header names are matched loosely: `Bill No`, `Invoice No` and `bill_number` all work (see `FIELDS` in [backend/src/importer.js](backend/src/importer.js)).

| Column | Required | Notes |
|---|---|---|
| Bill No, Bill Date | ✔ | Dates are read as DD-MM-YYYY (also accepts YYYY-MM-DD, 23-Sep-2026 or Excel dates) |
| Branch | ✔* | Branch code or name. *Or choose the branch when uploading |
| Net Eligible Value | ✔ | Basis for points |
| Customer Mobile / Customer Code | for members | Bills without either are counted as non-member sales |
| Bill Time, Bill Value, Discount | recommended | |
| Loyalty Ref, Loyalty Discount | for reconciliation | The Redemption ID can appear anywhere in the text, e.g. in remarks |
| Bill Type, Original Bill No | for returns | `SALE` (default), `RETURN`, `CANCELLED` |
| Product Code, Product, Category, Qty, Rate, Item Discount, Item Amount | optional | One row per item, with bill fields repeated. Stored and used for category segments and offers |

**How an upload is processed:**
- The file is validated first.
- A file identical to one already imported is rejected.
- Bills already imported are skipped as duplicates, so re-uploading is safe.
- Bad rows are reported with their row number and don't block the good ones.
- Customers are matched by mobile, then by customer code, and created if new.
- Points are credited, and purchase history and analytics are updated.
- Segments are recalculated.
- Redemptions are reconciled. Issues are flagged as: missing billing entry, wrong amount, duplicate redemption, cancelled bill, unmatched ID, redemption never approved, or customer mismatch.

## Project layout

Each app has its own folder. One backend serves all three, so they share one database and the same web addresses as before (`/customer`, `/manager`, `/admin`).

```
vasantham-loyalty/
├── backend/            server, database, Excel import, tests  (npm start runs this)
├── customer-app/
│   ├── web/            Customer App screens          → /customer
│   └── android-app/    Android APK wrapper (Capacitor) for the Customer App
├── manager-panel/      Manager Panel screens         → /manager
├── admin-panel/        Admin Panel screens           → /admin
├── shared/             styles, helpers, icon and start page used by all three → /shared, /
├── api/                Vercel entry point (the backend as one serverless function)
├── firebase/           Hosting build script (also used by Vercel)
├── vercel.json, firebase.json   deployment settings
└── package.json        shortcuts: npm start / test / seed / sample / demo
```

To serve an app from a different folder (for example when deploying it separately), set `CUSTOMER_APP_DIR`, `MANAGER_PANEL_DIR`, `ADMIN_PANEL_DIR` or `SHARED_DIR`.

Inside `backend/`:

```
data/              database, secret key, uploaded offer files and logos (back this up)
src/
  server.js        Express app, static hosting, housekeeping timers
  db.js            SQLite schema, transactions, settings
  util.js          points/money math, mobile normalisation, IST dates
  db-remote.js     Turso / libSQL connector (used when TURSO_DATABASE_URL is set)
  firebase.js      Firebase settings, phone-OTP verification
  media.js         offer images, PDFs and logos (files on disk, or in the database on Turso)
  auth.js          staff passwords, signed sessions, OTP, rotating customer QR, verification tickets
  points.js        points ledger
  offers.js        offer types, eligibility, auto bonus/multiplier engine
  redemptions.js   redemption lifecycle, approval (business rules), reversal, partner bill confirmation, receipt
  businesses.js    businesses / partners, earn & redeem permissions, redemption rules and caps
  settlement.js    cross-business settlement lines, report, settle / void
  rewards.js       granting bonus points / unlocking personalised offers
  challenges.js    spend milestones + visit challenges: periods, progress, tiered rewards
  automations.js   reactivation automations and their recovery measurement
  referrals.js     referral programme, codes, fraud checks, qualification
  engagement.js    after-upload and nightly hooks for the above
  growth.js        ecosystem growth dashboard, customer_business_activity
  rbac.js          roles, permissions, business scoping for the Admin API
  importer.js      Excel parsing, validation, points, returns
  reconcile.js     redemption ↔ bill reconciliation, issue tracking
  segments.js      automatic segmentation (thresholds in Settings)
  analytics.js     dashboard, liability, customer/branch/campaign analytics, manager daily report
  routes/          auth, customer (/api/me), manager, admin
scripts/           sample Excel generator, ecosystem demo data
test/              end-to-end tests
```

## Firebase (moving step by step)

Firebase is added one service at a time, each behind its own switch. Until a service is switched on, the app works exactly as before.

| Step | Service | Status |
|---|---|---|
| 1 | **Firebase Hosting**: the three apps at one `https://` address (`/customer`, `/manager`, `/admin`) | Ready; needs the backend deployed (step 5) before going live |
| 2 | **Phone OTP** (Firebase Authentication): customer login and the manager's "customer confirms with OTP" | Ready and tested on the Firebase emulator; switch on with credentials |
| 3 | **File storage** (offer images, PDFs, logos) | Next |
| 4 | **Push notifications** (Firebase Cloud Messaging) | Planned |
| 5 | **Database and backend** (PostgreSQL on Cloud SQL, backend on Cloud Run) | Planned |

**How Firebase OTP works here:** Firebase sends the SMS and checks the code in the app. The server then verifies the result with Firebase and logs the customer in through the same code as before, so points, referrals, profile and the birthday/anniversary rule behave exactly the same. For the manager's OTP check, the server also confirms the verified number is that customer's and was verified in the last 5 minutes. Once Firebase OTP is on, the built-in OTP endpoints are closed.

**Test locally without credentials** (uses the Firebase Emulator Suite on a `demo-` project, which never touches a real project):

```bash
npm run dev:firebase     # Firebase Auth emulator + server in Firebase mode; OTPs shown on screen
```

The Emulator UI is at http://127.0.0.1:4001.

**Switching on with a real project:**

1. In the Firebase console: create a project (region **asia-south1**), upgrade to the **Blaze** plan, then go to **Authentication → Sign-in method → Phone** and enable it.
2. Under **Authentication → Settings → Authorized domains**, add the domain the apps are served from.
3. Under **Project settings → General → Your apps**, add a Web app and copy its config into `backend/firebase.config.json` (start from `backend/firebase.config.example.json`), with `"enabled": true`.
4. Optional: download a service account key (**Project settings → Service accounts**) to `backend/firebase-service-account.json`. Phone OTP checking only needs the project ID; later steps use the key.
5. Restart the server. `GET /api/auth/config` now returns `"otpProvider": "firebase"`.
6. For testing without real SMS, add test numbers under **Authentication → Sign-in method → Phone → Phone numbers for testing**.

`firebase.config.json` and the service account key are excluded from Git; never commit them.

**Hosting:** `npm run build:hosting` packs the three app folders into `firebase/hosting-dist`. `npm run deploy:hosting` deploys them; `/api` and `/media` are forwarded to the backend on Cloud Run (`vasantham-backend`, asia-south1), see `firebase.json`.

## Deploying to Vercel

The repository is ready for Vercel: `vercel.json` builds the three apps as static files and runs the backend as one serverless function (`api/index.js`). **The function region in `vercel.json` must match the Turso database region** (currently `bom1` / Mumbai, next to the Turso database in `aws-ap-south-1`); each request makes many database calls, so they must be close together. Vercel keeps no files between requests, so on Vercel:

| Needs | How it works on Vercel |
|---|---|
| Database | **Turso** (hosted SQLite). The SQL is identical to the local database, so nothing is rewritten. Without `TURSO_DATABASE_URL` the app uses the local file as before. |
| Offer images, PDFs, logos | Stored in the database (`media_files`) automatically when Turso is used |
| Nightly segments and engagement | **Vercel Cron** calls `/api/cron/daily` at 00:05 IST, protected by `CRON_SECRET`. Expired redemption QRs are also cleaned up whenever one is used. |
| Firebase settings | `VL_FIREBASE_CONFIG` (the JSON of `backend/firebase.config.json`) |

**Steps:**

1. **Create a Turso database** in Mumbai (`aws-ap-south-1`), either in the Vercel dashboard (**Storage → Marketplace → Turso**, which adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to the project for you) or at turso.tech.
2. **Copy your existing data into it** (optional, from this PC): `TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… npm run db:copy-to-turso`. This copies every table and uploaded file and verifies the row counts. It refuses to overwrite a database that already has customers. For a fresh start, run `npm run seed` with the same two variables instead.
3. **Import the GitHub repository in Vercel** and leave the framework as **Other**; `vercel.json` sets the install, build and output.
4. **Environment variables:**

| Variable | Value |
|---|---|
| `APP_SECRET` | long random string; never change it (signs logins and QR codes) |
| `DEV_OTP` | `0` |
| `DATA_DIR` | `/tmp/data` |
| `CRON_SECRET` | long random string (Vercel sends it to the daily job) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | from step 1 |
| `VL_FIREBASE_CONFIG` | one-line JSON of `backend/firebase.config.json` (optional until Firebase OTP is on) |

**Limits to know:**
- Vercel accepts uploads of up to **4.5 MB** per request (offer attachments and Excel files). Upload POS data one day at a time.
- Each request can run for up to 5 minutes.
- **Customer OTP needs Firebase phone OTP switched on** (see the Firebase section) and the Vercel domain added to Firebase's authorized domains. Vercel has no SMS gateway, and with `DEV_OTP=0` the built-in OTP is only written to the server log. Staff logins don't need OTP.

**Testing the Turso path locally:** run a libSQL server (`docker run -p 18080:8080 ghcr.io/tursodatabase/libsql-server`) and start or test with `TURSO_DATABASE_URL=http://127.0.0.1:18080`. All tests pass on it.

## Before going live

1. **HTTPS.** Put the app behind a reverse proxy such as Nginx or Caddy. The manager's camera scanner requires HTTPS. USB/Bluetooth scanners and mobile search work without it.
2. **SMS gateway.** Implement `sendSms()` and set `DEV_OTP=0`.
3. **Secrets.** Set `APP_SECRET`. Otherwise a key is generated in `backend/data/secret.key`; keep that file safe and back it up.
4. **Backups.** Back up the `backend/data/` folder (database `vasantham.db` plus uploaded files) daily. SQLite in WAL mode handles many branches comfortably. If the business outgrows it, the SQL is portable to PostgreSQL.
5. **Passwords.** Change all seeded passwords under Admin → Branches & staff.
6. **POS.** Ask the billing team to add the **Redemption ID** and **Loyalty Discount** columns to the daily export. Reconciliation depends on them.

## Deliberately out of scope

The following are left out, per the brief:
- Online shopping, catalogue, delivery, payments and subscriptions.
- Gamification, membership tiers, recipes and social features.
- Automatic AI recommendations: cross-business targeting uses segments and rules that management controls.

Push notifications are recorded in-app only, and promotional ones are capped per customer per day. Delivering them through FCM or an app store build is the natural next step, as is a direct POS API to replace the Excel upload.
