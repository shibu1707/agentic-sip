import { encryptDotnet, decryptDotnet } from "./crypto.js";

function getBaseUrl() {
  return (process.env.KOTAK_API_BASE_URL || "https://unificationapi.kotakmf.com") + "/KMFUnification/api";
}

function toUserId(mobile) {
  return mobile.replace(/^\+91/, "").replace(/\s/g, "");
}

// ─── Cookie jar ───────────────────────────────────────────────────────────────
// Populated from Set-Cookie headers during login, forwarded in every subsequent
// request so Kotak's AWS load balancer routes us to the same backend instance.
let _cookieJar = "";

export function getCookieJar() { return _cookieJar; }
export function setCookieJar(c) { _cookieJar = c; }
export function clearCookieJar() { _cookieJar = ""; }

function extractSetCookies(response) {
  try {
    const sc = response.headers.getSetCookie?.() || [];
    return sc.map(c => c.split(";")[0]).join("; ");
  } catch { return ""; }
}

function mergeCookies(existing, incoming) {
  if (!incoming) return existing;
  // Merge by name — newer value wins
  const map = new Map();
  for (const pair of (existing + "; " + incoming).split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq), trimmed);
  }
  return [...map.values()].join("; ");
}

// ─── Rolling debug log ────────────────────────────────────────────────────────
export const responseLog = [];
export function clearResponseLog() { responseLog.length = 0; }

// ─── Core HTTP ────────────────────────────────────────────────────────────────
async function kotakPost(path, encryptedBody, securityKey = null) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.kotakmf.com",
    "Referer": "https://www.kotakmf.com/",
    "User-Agent": "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
  };
  if (securityKey) headers["securityKey"] = securityKey;
  if (_cookieJar) headers["Cookie"] = _cookieJar;

  const url = `${getBaseUrl()}${path}`;
  const response = await fetch(url, { method: "POST", headers, body: encryptedBody });

  // Merge any new cookies into the jar
  const newCookies = extractSetCookies(response);
  if (newCookies) _cookieJar = mergeCookies(_cookieJar, newCookies);

  // Capture for debug log
  const respHeaders = {};
  response.headers.forEach((v, k) => { respHeaders[k] = v; });

  if (!response.ok) {
    const text = await response.text();
    responseLog.push({ path, status: response.status, headers: respHeaders, error: text.slice(0, 400) });
    throw new Error(`Kotak API ${response.status} on ${path}: ${text.slice(0, 400)}`);
  }

  const raw = await response.text();
  const stripped = raw.startsWith('"') ? JSON.parse(raw) : raw;
  let body;
  try {
    body = JSON.parse(decryptDotnet(stripped));
  } catch {
    try { body = JSON.parse(raw); } catch { body = raw; }
  }

  responseLog.push({ path, status: response.status, headers: respHeaders, body });
  if (responseLog.length > 20) responseLog.shift();
  return body;
}

// ─── Payload builder ──────────────────────────────────────────────────────────
// Adds SESSION_ID only when the session actually has an Invetorlink.
// Post-first-login the session is maintained via AWSALB cookie instead.
function authPayload(fields, session) {
  const data = {
    ...fields,
    USER_ID: toUserId(session.mobile),
    ...(session.investorLink
      ? { SESSION_ID: session.investorLink, SESSION_VALIDATE: "Y" }
      : {}),
  };
  return encryptDotnet(JSON.stringify(data));
}

// ─── Login flow ───────────────────────────────────────────────────────────────

export async function checkUserDet(mobile) {
  const bare = toUserId(mobile);
  return kotakPost("/Admin/check/USERDET", encryptDotnet(JSON.stringify({ MOBILE_NO: bare })));
}

export async function sendOtpV2({ mobile, pan }) {
  const bare = toUserId(mobile);
  return kotakPost("/Admin/GETMOBVALIDATEV2", encryptDotnet(JSON.stringify({
    FLAG: "GETMOBVALIDATENEW",
    MOBILE_NO: bare, PAN: pan, TYPE: "LOGINNEW", EMAIL_ID: "",
    RESENDOTP: "M", COUNTRY_CODE: "+91",
    SOURCE: { Source: "msite", OS: "Linux" }, USER_CAT: "E",
  })));
}

export async function validateOtp({ mobile, otp }) {
  const bare = toUserId(mobile);
  return kotakPost("/Admin/OTPVALIDATE", encryptDotnet(JSON.stringify({
    FLAG: "VALIDATEOTPLOGIN", TYPE: "CHECKLOGINNEW",
    STATUS: "UNLOCK", USERINFO: bare, OTP: Number(otp),
  })));
}

export async function getMpinDetByMob({ mobile, email = "" }) {
  const bare = toUserId(mobile);
  return kotakPost("/Admin/GETMPINDETBYMOB", encryptDotnet(JSON.stringify({
    MOB_NUM: bare, DEVICE_ID: "WEB", EMAIL_ID: email, COUNTRY_CODE: "+91",
  })));
}

// checkLoginNew also seeds the cookie jar with the AWSALB sticky-session cookie
export async function checkLoginNew({ mobile, mpin }) {
  const bare = toUserId(mobile);
  const pin = String(mpin);
  return kotakPost("/Admin/CHECKLOGINNEW", encryptDotnet(JSON.stringify({
    FLAG: "CHECKLOGINNEW", USER_NAME: bare, LOGIN_NAME: bare,
    MOB_PIN: pin, VERSION: "6.7", MODE: "CHKPIN", DEVICE_ID: "WEB",
    MINFO: `WEB$#$6.7$#$6$#$A$#$${bare}$#$${pin}$#$USER_LOGIN`, USER_FROM: "M",
  })));
}

// Called by the browser immediately after CHECKLOGINNEW — audit log + finalises session
export async function insertLoginDetails({ mobile, email = "" }) {
  const bare = toUserId(mobile);
  return kotakPost("/Admin/INSERTLOGINDETAILS", encryptDotnet(JSON.stringify({
    FLAG: "INSERT_LOGINDETAILS",
    USER_ID: bare, EMAILID: email, CONTACT_NAME: "",
    SERVER_IP: "", CLIENT_IP: "", CURRENT_ACTION: "KMFLOGIN",
    MSG3: "", FOLIO_NO: "", COMMON: "", BROK_DLR_CODE: "",
    ARN_EMP_CODE: "", TRANSACTION_DETAILS: "", MULTI_SCHDETAILS: "",
    SOURCE: { Source: "msite", OS: "Linux" },
  })));
}

// ─── Authenticated calls ──────────────────────────────────────────────────────
// When session.investorLink is set → uses SESSION_ID + securityKey header (classic API mode)
// When absent → uses USER_ID + PAN only, relying on AWSALB cookie (fresh-login mode)

export async function getPortfolioDetails(session) {
  const bare = toUserId(session.mobile);
  const enc = session.investorLink
    ? authPayload({ FLAG: "GETPORTFOLIODETAILS", PAN: session.pan, USER_FROM: "" }, session)
    : encryptDotnet(JSON.stringify({ FLAG: "GETPORTFOLIODETAILS", USER_ID: bare, PAN: session.pan }));
  return kotakPost("/Admin/GETPORTFOLIODETAILS", enc, session.investorLink || null);
}

// Get folio summary — browser uses this for the folio list view (SESSION_ID required)
export async function getFolioSumm({ folioNo }, session) {
  const enc = authPayload({ FLAG: "GETFOLIOSUMM", FOLIO: folioNo }, session);
  return kotakPost("/Admin/GETFOLIOSUMM", enc, session.investorLink || null);
}

// Get SIP activation details for a folio (no SESSION_ID needed — uses FOLIO only)
export async function getSipActivationDet({ folioNo }) {
  return kotakPost("/Admin/GETFOLIODETAILS",
    encryptDotnet(JSON.stringify({ FLAG: "GETSIPACTIVATIONDET", FOLIO: folioNo }))
  );
}

export async function getFolioDetails({ folioNo, trxnType = "SIP" }, session) {
  const enc = authPayload(
    { FLAG: "GETIMDETKYC", FOLIO: folioNo, TRXN_TYPE: trxnType, TRXN_MODE: "FT" },
    session
  );
  return kotakPost("/Admin/GETFOLIODETAILS", enc, session.investorLink || null);
}

export async function getSchemeNames({ schemeType = "ALL" }, session) {
  const enc = authPayload({ FLAG: "GETSCHEMENAMESTPCHECKED", SCHEME_TYPE: schemeType }, session);
  return kotakPost("/Admin/GETSCHEMENAMESTPCHECKED", enc, session.investorLink || null);
}

export async function getSchemeStatus({ schemeCd }, session) {
  const enc = authPayload({ FLAG: "GETSCHEMESTATUS", SCHEME_CD: schemeCd }, session);
  return kotakPost("/Admin/GETSCHEMESTATUS", enc, session.investorLink || null);
}

export async function getSipInstallments({ schemeCd, folioNo = "" }, session) {
  const enc = authPayload(
    { FLAG: "GETSIPINSTALMENTSTPCHECKED", SCHEME_CD: schemeCd, FOLIO_NO: folioNo },
    session
  );
  return kotakPost("/Admin/GETSIPINSTALMENTSTPCHECKED", enc, session.investorLink || null);
}

export async function getOtmList({ folioNo }, session) {
  const enc = authPayload({ FLAG: "GETOTMDETLIST", FOLIO_NO: folioNo }, session);
  return kotakPost("/Admin/GETOTMDETLIST", enc, session.investorLink || null);
}

export async function getIfscDetails({ ifsc }, session) {
  const enc = authPayload({ FLAG: "GETIFSCDET", IFSC_CD: ifsc }, session);
  return kotakPost("/Admin/GETIFSCDET", enc, session.investorLink || null);
}

export async function getMappedSchemeType(session) {
  const enc = authPayload({ FLAG: "GETMAPPEDSCHEMETYPE" }, session);
  return kotakPost("/Admin/GETMAPPEDSCHEMETYPE", enc, session.investorLink || null);
}

export async function getFolioList({ mobile, otp }) {
  const bare = toUserId(mobile);
  return kotakPost("/Admin/GETFOLIOLIST", encryptDotnet(JSON.stringify({
    FLAG: "GETFOLIOLIST", TYPE: "UNLOCK", MOBILE_NO: bare, OTP: Number(otp),
  })));
}

export async function registerSip(
  { folioNo, schemeCd, amount, frequency, startDate, endDate, otmId, bankAccountNo },
  session
) {
  const enc = authPayload({
    FLAG: "REGISTERSIP", FOLIO_NO: folioNo, SCHEME_CD: schemeCd,
    AMOUNT: String(amount), FREQUENCY: frequency,
    START_DATE: startDate, END_DATE: endDate,
    OTM_ID: otmId, BANK_ACCOUNT_NO: bankAccountNo,
  }, session);
  return kotakPost("/Admin/REGISTERSIP", enc, session.investorLink || null);
}
