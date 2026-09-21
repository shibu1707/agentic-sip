import { encryptDotnet, decryptDotnet } from "./crypto.js";

function getBaseUrl() {
  return (process.env.KOTAK_API_BASE_URL || "https://unificationapi.kotakmf.com") + "/KMFUnification/api";
}

// Strip +91 prefix to get bare 10-digit USER_ID
function toUserId(mobile) {
  return mobile.replace(/^\+91/, "").replace(/\s/g, "");
}

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
  if (securityKey) {
    headers["securityKey"] = securityKey;
  }

  const url = `${getBaseUrl()}${path}`;
  // Body is sent as raw encrypted string — no strInput= wrapper
  const response = await fetch(url, { method: "POST", headers, body: encryptedBody });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kotak API ${response.status} on ${path}: ${text.slice(0, 400)}`);
  }

  // Response is also encrypted — decrypt it
  const raw = await response.text();
  // Strip surrounding JSON quotes if present
  const stripped = raw.startsWith('"') ? JSON.parse(raw) : raw;
  try {
    return JSON.parse(decryptDotnet(stripped));
  } catch {
    // Some endpoints return plain JSON
    return JSON.parse(raw);
  }
}

// Build the standard authenticated payload and encrypt it
function authPayload(fields, session) {
  const data = {
    ...fields,
    USER_ID: toUserId(session.mobile),
    SESSION_ID: session.investorLink,
    SESSION_VALIDATE: "Y",
  };
  return encryptDotnet(JSON.stringify(data));
}

// ─── Login flow ───────────────────────────────────────────────────────────────

// Step 1: trigger OTP — plain JSON, no encryption
export async function preLoginSession({ pan, email, mobile }) {
  const plain = JSON.stringify({
    FLAG: "PRELOGINSIP",
    INVESTOR_NAME: pan,
    EMAIL_ID: email,
    MOBILE_NO: mobile,
    UTM_SOURCE: "",
    UTM_MEDIUM: "",
    UTM_CAMPAIGN: "",
    UTM_TERM: "",
    URL: "/investor/SIP-PreLogin-Mobile-Submit",
    AS_STEP: "1",
  });
  return kotakPost("/Admin/PRELOGINSESSION", plain);
}

// Step 2: validate OTP → get Invetorlink (SESSION_ID for all subsequent calls)
export async function getMobValidate({ mobile, otp, sessionIdFromStep1 }) {
  const enc = encryptDotnet(
    JSON.stringify({ FLAG: "GETMOBVALIDATE", MOBILE_NO: mobile, OTP: otp })
  );
  return kotakPost("/Admin/GETMOBVALIDATE", enc, sessionIdFromStep1);
}

// Step 3: get OTP-based folio list (plain JSON)
export async function getFolioList({ mobile, otp }) {
  const plain = JSON.stringify({
    FLAG: "GETFOLIOLIST",
    TYPE: "UNLOCK",
    MOBILE_NO: mobile,
    OTP: otp,
  });
  return kotakPost("/Admin/GETFOLIOLIST", plain);
}

// ─── Authenticated calls (require Invetorlink in SESSION_ID) ──────────────────

// Get portfolio summary (all folios + investor name)
export async function getPortfolioDetails(session) {
  const enc = authPayload(
    { FLAG: "GETPORTFOLIODETAILS", PAN: session.pan, USER_FROM: "" },
    session
  );
  return kotakPost("/Admin/GETPORTFOLIODETAILS", enc, session.investorLink);
}

// Get folio details + KYC info
export async function getFolioDetails({ folioNo, trxnType = "SIP" }, session) {
  const enc = authPayload(
    { FLAG: "GETIMDETKYC", FOLIO: folioNo, TRXN_TYPE: trxnType, TRXN_MODE: "FT" },
    session
  );
  return kotakPost("/Admin/GETFOLIODETAILS", enc, session.investorLink);
}

// Get available scheme names
export async function getSchemeNames({ schemeType = "ALL" }, session) {
  const enc = authPayload(
    { FLAG: "GETSCHEMENAMESTPCHECKED", SCHEME_TYPE: schemeType },
    session
  );
  return kotakPost("/Admin/GETSCHEMENAMESTPCHECKED", enc, session.investorLink);
}

// Get scheme status
export async function getSchemeStatus({ schemeCd }, session) {
  const enc = authPayload({ FLAG: "GETSCHEMESTATUS", SCHEME_CD: schemeCd }, session);
  return kotakPost("/Admin/GETSCHEMESTATUS", enc, session.investorLink);
}

// Get SIP installment options for a scheme
export async function getSipInstallments({ schemeCd, folioNo = "" }, session) {
  const enc = authPayload(
    { FLAG: "GETSIPINSTALMENTSTPCHECKED", SCHEME_CD: schemeCd, FOLIO_NO: folioNo },
    session
  );
  return kotakPost("/Admin/GETSIPINSTALMENTSTPCHECKED", enc, session.investorLink);
}

// Get OTM / bank mandate list
export async function getOtmList({ folioNo }, session) {
  const enc = authPayload({ FLAG: "GETOTMDETLIST", FOLIO_NO: folioNo }, session);
  return kotakPost("/Admin/GETOTMDETLIST", enc, session.investorLink);
}

// Get bank IFSC details
export async function getIfscDetails({ ifsc }, session) {
  const enc = authPayload({ FLAG: "GETIFSCDET", IFSC_CD: ifsc }, session);
  return kotakPost("/Admin/GETIFSCDET", enc, session.investorLink);
}

// Get scheme type list
export async function getMappedSchemeType(session) {
  const enc = authPayload({ FLAG: "GETMAPPEDSCHEMETYPE" }, session);
  return kotakPost("/Admin/GETMAPPEDSCHEMETYPE", enc, session.investorLink);
}

// Register SIP
export async function registerSip(
  { folioNo, schemeCd, amount, frequency, startDate, endDate, otmId, bankAccountNo },
  session
) {
  const enc = authPayload(
    {
      FLAG: "REGISTERSIP",
      FOLIO_NO: folioNo,
      SCHEME_CD: schemeCd,
      AMOUNT: String(amount),
      FREQUENCY: frequency,
      START_DATE: startDate,
      END_DATE: endDate,
      OTM_ID: otmId,
      BANK_ACCOUNT_NO: bankAccountNo,
    },
    session
  );
  return kotakPost("/Admin/REGISTERSIP", enc, session.investorLink);
}
