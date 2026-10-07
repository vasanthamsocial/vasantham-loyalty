// Phone OTP for the Customer App and Manager Panel.
// The server decides the provider: its built-in OTP, or Firebase Authentication once switched on.
const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

let cfgPromise;
function config(api) {
  cfgPromise ??= api.get('/auth/config').catch((e) => {
    cfgPromise = null;
    throw e;
  });
  return cfgPromise;
}

/** 'local' (built-in OTP) or 'firebase'. */
export async function otpMode(api) {
  return (await config(api)).otpProvider;
}

/** Same rules as the server: 10 digits starting 6–9, +91 / leading 0 allowed. */
export function tenDigitMobile(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

const MESSAGES = {
  'auth/invalid-verification-code': 'Incorrect OTP',
  'auth/code-expired': 'OTP expired. Please request a new OTP.',
  'auth/session-expired': 'OTP expired. Please request a new OTP.',
  'auth/too-many-requests': 'Too many attempts. Please try again later.',
  'auth/quota-exceeded': 'OTP limit reached for now. Please try again later.',
  'auth/invalid-phone-number': 'Enter a valid 10-digit mobile number',
  'auth/missing-phone-number': 'Enter a valid 10-digit mobile number',
  'auth/network-request-failed': 'Network error — check your connection',
  'auth/captcha-check-failed': 'Security check failed. Please try again.',
};
const friendly = (e) => new Error(MESSAGES[e?.code] || e?.message || 'Could not verify the OTP');

/**
 * A Firebase phone-OTP session. send(mobile) texts the code; verify(code) returns a
 * Firebase ID token for the server to check. Uses its own Firebase app instance and
 * signs out straight away, so it only proves the phone number and never keeps a session.
 */
export async function firebaseOtp(api) {
  const cfg = await config(api);
  const [{ initializeApp, getApps }, A] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]);
  const app = getApps().find((a) => a.name === 'vl-otp') || initializeApp(cfg.firebase, 'vl-otp');
  const auth = A.getAuth(app);
  if (cfg.authEmulatorUrl && !auth.emulatorConfig) A.connectAuthEmulator(auth, cfg.authEmulatorUrl, { disableWarnings: true });
  auth.languageCode = 'en';

  let box = document.getElementById('vl-recaptcha');
  if (!box) {
    box = document.createElement('div');
    box.id = 'vl-recaptcha';
    document.body.appendChild(box);
  }
  let verifier;
  let confirmation;
  return {
    async send(mobile) {
      verifier?.clear();
      box.innerHTML = '';
      const holder = document.createElement('div');
      box.appendChild(holder);
      verifier = new A.RecaptchaVerifier(auth, holder, { size: 'invisible' });
      try {
        confirmation = await A.signInWithPhoneNumber(auth, `+91${mobile}`, verifier);
      } catch (e) {
        throw friendly(e);
      }
      const devOtp = cfg.devOtp ? (await api.get(`/auth/dev-otp?mobile=${mobile}`)).devOtp : undefined;
      return { devOtp };
    },
    async verify(code) {
      if (!confirmation) throw new Error('Please request an OTP first');
      try {
        const cred = await confirmation.confirm(String(code || '').trim());
        const idToken = await cred.user.getIdToken();
        await A.signOut(auth);
        return idToken;
      } catch (e) {
        throw friendly(e);
      }
    },
  };
}
