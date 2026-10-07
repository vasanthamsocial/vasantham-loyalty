import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the three front-end apps live in their own folders next to backend/
const apps = process.env.APPS_DIR || path.resolve(root, '..');

export const CONFIG = {
  root,
  port: Number(process.env.PORT || 4000),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  dbFile: process.env.DB_FILE || 'vasantham.db',

  // front-end folders, served at /customer, /manager, /admin and /shared
  webDirs: {
    customer: process.env.CUSTOMER_APP_DIR || path.join(apps, 'customer-app', 'web'),
    manager: process.env.MANAGER_PANEL_DIR || path.join(apps, 'manager-panel'),
    admin: process.env.ADMIN_PANEL_DIR || path.join(apps, 'admin-panel'),
    shared: process.env.SHARED_DIR || path.join(apps, 'shared'),
  },

  // Loyalty economics (V1 fixed business rules)
  rupeesPerPoint: 200, // ₹200 eligible spend = 1 point
  pointValueRupees: 2, // 1 point = ₹2 reward value

  // Security windows
  customerQrValiditySec: 15 * 60, // rotating customer QR
  redemptionTokenValiditySec: 10 * 60, // one-time redemption token
  verificationTicketSec: 15 * 60, // manager's proof that customer is present
  otpValiditySec: 5 * 60,
  otpMaxAttempts: 5,
  otpMaxPerHour: 5,
  staffSessionHours: 12,
  customerSessionDays: 30,

  // Development: show OTP in API response + console instead of SMS
  devShowOtp: process.env.DEV_OTP !== '0',

  timezoneOffsetMin: 330, // IST
};

// Configurable thresholds (admin editable, stored in settings table)
export const DEFAULT_SETTINGS = {
  seg_new_days: 30,
  seg_active_days: 30,
  seg_dormant_days: 90,
  seg_regular_min_visits_90d: 4,
  seg_high_value_spend_90d: 15000,
  seg_decline_ratio: 0.5,
  seg_weekend_share: 0.6,
  seg_category_share: 0.4,
  seg_overdue_factor: 1.25, // overdue once days since last visit ≥ usual gap × this (min 14 days)
  min_redeem_points: 1,
  max_redeem_points: 0, // 0 = no limit
  require_otp_for_mobile_redemption: 1,
  missing_bill_grace_days: 1,
  notif_daily_cap: 3,
};
