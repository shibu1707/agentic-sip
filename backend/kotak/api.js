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

// Get scheme status for SIP — FLAG from browser: GETIPSCH_ADMIN with TYPE and PAN
export async function getSchemeStatus({ schemeCode, type = "SIP" }, session) {
  const enc = authPayload({
    FLAG: "GETIPSCH_ADMIN", SCHEME_CODE: String(schemeCode), TYPE: type, PAN: session.pan || "",
  }, session);
  return kotakPost("/Admin/GETSCHEMESTATUS", enc, session.investorLink || null);
}

// Get schemes invested in a folio — returns SCHEME_CODE (numeric), SHORT_NAME, LONG_NAME
export async function getFolioSchemes({ folioNo }, session) {
  const enc = authPayload({
    FLAG: "GETIPSCHEME", FOLIO: folioNo, BROKER_FLAG: "R", SESSION_VALIDATE: "N",
  }, session);
  return kotakPost("/Admin/GETADMINSCHEMEDETAILS", enc, session.investorLink || null);
}

// Get SIP date constraints and limits for a scheme
export async function getSchemeDateDetails({ schemeCode, frequency = "OM" }, session) {
  const enc = authPayload({
    FLAG: "ALLOWED_DATE", SCHEME_CODE: String(schemeCode),
    FREQUENCY_VALUE: frequency, INVESTMENT_TYPE: "SIP", TYPE: "P",
  }, session);
  return kotakPost("/Admin/GETSCHEMEDATEDETAILS", enc, session.investorLink || null);
}

// Get real min/max lumpsum purchase amounts for a scheme — works even for schemes the
// investor has no existing folio in (FOLIO here just anchors the request to any of their
// existing folios; SCHEME_CODE is the one actually being queried). Confirmed from HAR capture.
export async function getNewPurchaseSchemeDetails({ folioNo, schemeCode }, session) {
  const enc = authPayload({
    FLAG: "GETNPSCHDET", FOLIO: folioNo || "", SCHEME_CODE: String(schemeCode),
  }, session);
  return kotakPost("/Admin/GETSCHEMENAME", enc, session.investorLink || null);
}

// Get bank account linked to a folio for autopay SIP debit
export async function getExitBankName({ folioNo, paymentMode = "AUTOPAY" }, session) {
  const enc = authPayload({
    FLAG: "GETEXITBANKNAME", FOLIO: folioNo, PAYMENT_MODE: paymentMode,
  }, session);
  return kotakPost("/Admin/GETEXITBANKNAME", enc, session.investorLink || null);
}

// Validate folio for a transaction type
export async function validateFolio({ folioNo, type = "SIP" }, session) {
  const enc = authPayload({
    FLAG: "VALIDATEMAPPEDFOLIO", FOLIO: folioNo, TYPE: type, USER_FROM: "",
  }, session);
  return kotakPost("/Admin/GETFOLIOSVALIDATE", enc, session.investorLink || null);
}

// Check OTM/NACH mandate — uses KEY1/IV1 encryption (URL-safe base64, different endpoint format)
export async function checkOtmMandate({ pan, mobile }) {
  const enc = encryptDotnet(JSON.stringify({ PAN: pan, MOBILE: mobile }));
  return kotakPost("/Admin/fetch/pan/otm/det", enc);
}

// Get scheme details for a folio (units, value, min/max amounts)
export async function getSchemeDetails({ folioNo, schemeCode }, session) {
  const enc = authPayload({
    FLAG: "GETIPSCHDET", FOLIO: folioNo, SCHEME_CODE: String(schemeCode),
  }, session);
  return kotakPost("/Admin/GETSCHEMEDETAILS", enc, session.investorLink || null);
}

export async function getIfscDetails({ ifsc }, session) {
  const enc = authPayload({ FLAG: "GET_IFSC_DET", IFSCCODE: ifsc }, session);
  return kotakPost("/Admin/GETIFSCDET", enc, session.investorLink || null);
}

// Get investor profile (mobile, email, address) registered on a folio
export async function getInvestorDetails({ folioNo }, session) {
  const enc = authPayload({
    FLAG: "GETINVESTORDETAILS", FOLIO: folioNo,
  }, session);
  return kotakPost("/Admin/INSTREDMEEMFOLIO", enc, session.investorLink || null);
}

// Browse all available Kotak MF schemes for purchase/SIP
export async function getAvailableSchemes({ type = "P", loginFrom = "POST" }, session) {
  const enc = authPayload({
    FLAG: "GETADSCHMES", TYPE: type, LOGIN_FROM: loginFrom,
  }, session);
  return kotakPost("/Admin/GETADSCHEMEDETAILS", enc, session.investorLink || null);
}

// Create a lumpsum purchase transaction — returns user_trxn_no on success
// Step 1 of purchase: send transaction-authorization OTP to the investor's mobile.
// This is a SEPARATE OTP from login — Kotak requires it per-transaction (TRXN_TYPE 'AP').
// Real frontend also fires a parallel email OTP; we only need one verified channel, so we use mobile.
export async function getLumpsumTransactionOtp({ folioNo = "" }, session) {
  const bare = toUserId(session.mobile);
  const payload = {
    FLAG: "GETOTPNEW",
    FOLIO: String(folioNo || ""),
    SMSSERVICECODE: "KMFLPOTP",
    MOBILE_NO: bare,
    USER_ID: bare,
    SESSION_ID: session.investorLink || "",
    OTP_TYPE: "M",
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/GETOTPNEW", enc, session.investorLink || null);
}

// Step 2: verify the transaction OTP the investor received on their mobile.
export async function verifyLumpsumTransactionOtp({ folioNo = "", otp }, session) {
  const bare = toUserId(session.mobile);
  const payload = {
    FLAG: "VALIDATEOTPLOGIN",
    FOLIO: String(folioNo || ""),
    OTP: otp,
    USER_ID: bare,
    SESSION_ID: session.investorLink || "",
    SESSION_VALIDATE: "Y",
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/VALIDATEOTPLOGIN", enc, session.investorLink || null);
}

// Step 3: submit the actual purchase. Requires a verified transaction OTP from the two
// functions above — otpFlag/otpFlagValue must reflect that verification, real Kotak
// frontend never sends otpFlag:"N" here (only 'M' for mobile or 'E' for email).
export async function createLumpsumTransaction({
  schemeCode, schemeName, amount,
  folioNo = "",          // empty = new folio
  paymentMode = "UPI",   // UPI | Internet Banking | OTM | NEFT
  upiVpa = "",
  idcwOption = "Z",      // Z = Growth
  brokerId = "ARN-114376",
  euin = "E207433",
  bankName = "IDFC FIRST Bank",
  bankAccNo = "10144265120",
  bankAccType = "SB",
  bankBranch = "NEW DELHI- KALKAJI BRANCH",
  bankCity = "SOUTH-EAST DELHI",
  bankIfsc = "IDFB0020215",
}, session) {
  const bare = toUserId(session.mobile);
  // otpFlagValue must be the SINGLE verified identifier (mobile number alone), matching
  // real frontend behaviour — never the comma-joined mobile+email pair used previously.
  const otpFlag = "M";
  const otpFlagValue = bare;
  const reqId = String(Date.now()).slice(-10); // real client sends a non-empty numeric reqId
  const payload = {
    flag: "ADDPURCHASETRXN",
    reqId,
    folio: folioNo,
    folio_no: folioNo,
    perkrn: "",
    pan: session.pan || "",
    email: session.email || "",
    mobile: bare,
    user_id: bare,
    tax_no: session.pan || "",
    user_refid: "",
    session_id: session.investorLink || "",
    USER_NAME: session.investorName || bare,
    USER_TYPE: "POSTLOGIN",
    payment_mode: paymentMode,
    data: {
      schemeOptions: [{
        schemeCode: String(schemeCode),
        schemename: schemeName,
        amount,
        idcwOption,
        distId: brokerId,
        subBrokerARN: "",
        subDist: "",
        euin,
        euinFlag: "Y",
        ria: "",
        riaFlag: "N",
      }],
      bank: { name: bankName, acctNo: bankAccNo, acctType: bankAccType, branch: bankBranch, city: bankCity, ifscCode: bankIfsc },
      mandateRefId: "",
      omUMRN: "",
      upiId: upiVpa,
      payinMech: paymentMode === "UPI" ? "WEB" : paymentMode,
      minorWhiteListFlag: "",
      image: "",
      originTxn: "MKMFONLINE",
      camsMandateRefId: "",
      otpFlag,
      otpFlagValue,
      targetNfoScheme: "",
      packageName: "",
      NFO_SWITCH_OPT: "",
      NFO_SWITCH_DATE: "",
      dpId: "",
    },
    totalamt: amount,
    IP_ADDRESS: "",
    ACTIVITY: "",
    login_type: "",
    log_type: "",
    URL: "KOTAKMFADMINAPI",
    SOURCE: { Source: "msite", OS: "Linux" },
    CLIENT_IP: "",
    UTM_SOURCE: "", UTM_MEDIUM: "", UTM_CAMPAIGN: "", UTM_TERM: "", LEAD_URL: "",
    UTM_ADGROUP: "", UTM_NETWORK: "", UTM_MATCHTYPE: "", UTM_DEVICE: "", UTM_PLACEMENT: "",
    UTM_CONTENT: "", UTM_ADPOSITION: "", UTM_LOCATION: "", UTM_CAMPAIGNID: "", UTM_SITELINK: "",
    GAD_SOURCE: "", GAD_CAMPAIGNID: "", GBRAID: "", GCLID: "",
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/LUMPSUMTRXN", enc, session.investorLink || null);
}

// Get Razorpay order ID for UPI/online payment of a lumpsum transaction
export async function getRazorpayOrderId({ folioNo, amount, trxnType = "Lumpsum" }, session) {
  const payload = {
    USER_TYPE: "POST-LOGIN",
    TRXN_TYPE: trxnType,
    METHOD: "upi",
    FOLIO_NO: folioNo,
    SESSION_ID: session.investorLink || "",
    AMOUNT: String(amount),
    BankCode: "",
    AC_NO: "10144265120",
    IFSC: "IDFB0020215",
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/ROZORPAYORDERID", enc, session.investorLink || null);
}

export async function getSipInstallments({ schemeCd, folioNo = "" }, session) {
  const enc = authPayload(
    { FLAG: "GETSIPINSTALMENTSTPCHECKED", SCHEME_CD: schemeCd, FOLIO_NO: folioNo },
    session
  );
  return kotakPost("/Admin/GETSIPINSTALMENTSTPCHECKED", enc, session.investorLink || null);
}

// Step 1 of SIP registration: send transaction-authorization OTP to the investor's mobile.
// Same GETOTPNEW mechanism as lumpsum purchases, but SIP uses SMSSERVICECODE "KMFSIPOTP"
// (confirmed from Angular source: get-otp-popup.component.ts, case 'SIP').
export async function getSipTransactionOtp({ folioNo = "" }, session) {
  const bare = toUserId(session.mobile);
  const payload = {
    FLAG: "GETOTPNEW",
    FOLIO: String(folioNo || ""),
    SMSSERVICECODE: "KMFSIPOTP",
    MOBILE_NO: bare,
    USER_ID: bare,
    SESSION_ID: session.investorLink || "",
    OTP_TYPE: "M",
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/GETOTPNEW", enc, session.investorLink || null);
}

// Step 2: verify the SIP transaction OTP the investor received on their mobile.
export async function verifySipTransactionOtp({ folioNo = "", otp }, session) {
  const bare = toUserId(session.mobile);
  const payload = {
    FLAG: "VALIDATEOTPLOGIN",
    FOLIO: String(folioNo || ""),
    OTP: otp,
    USER_ID: bare,
    SESSION_ID: session.investorLink || "",
    SESSION_VALIDATE: "Y",
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/VALIDATEOTPLOGIN", enc, session.investorLink || null);
}

// Step 3: register SIP via SIPTRXN — every field below confirmed against a real successful
// transaction (HAR capture www.kotakmf.com3.har, trxnNo 21529233, 23-Sep-2026). Do not "clean up"
// the empty-looking fields (reqId, USER_NAME) — Kotak's backend expects them empty; sending
// anything else can silently break the request.
export async function registerSip(
  {
    folioNo, schemeCode, schemeName = "", amount, frequency = "OM",
    sipDay = "1", numInstallments, startDate, endDate,
    paymentMode = "ISIP",
    mandateRefId = "",   // = PayoutID from getMandateStatus, once approved
    umrn = "",            // = om_umrn from getMandateStatus
    requestRefno = "",    // = the original cp_mandate_ref_no from registerUpiMandate
    camsMandateRefId = "",
    // bank details — MUST be the investor's actual linked bank (e.g. from getExitBankName),
    // never hardcode a specific bank here.
    bankName, bankAccNo, bankAccType = "SB", bankBranch = "", bankCity = "", bankIfsc,
    // broker details (from GETSCHEMEDETAILS)
    brokerId = "ARN-114376",
    euin = "E207433",
  },
  session
) {
  const payload = {
    FLAG: "SIP",
    reqId: "",
    FOLIO: folioNo,
    folio_no: folioNo,
    perkrn: "",
    pan: session.pan || "",
    email: session.email || "",
    mobileNo: session.mobile,
    investorName: session.investorName || toUserId(session.mobile),
    user_id: toUserId(session.mobile),
    USER_NAME: "",
    USER_TYPE: "POSTLOGIN",
    payment_mode: paymentMode,
    data: {
      schemeOptions: [{
        schemeCode: String(schemeCode),
        SchemeName: schemeName,
        amount,
        idcwOption: "Z",           // Growth = Not Applicable
        distId: brokerId,
        subBrokerARN: "",
        subDist: "",
        euin,
        euinFlag: "N",
        ria: "",
        riaFlag: "N",
        frequency,
        sipDay: Number(sipDay),
        NO_OF_INSTALLMENTS: String(numInstallments ?? ""),
        perpflag: "",
        startDate,
        endDate,
        stepUp: { frequency: "", amount: "", percent: "", maxCap: "", regno: "" },
        smartSipMinAmt: "",
        smartSipMaxAmt: "",
        specialProduct: "N",
        specialProductSubOption: "",
        upperLimit: "",
        lowerLimit: "",
      }],
      bank: { name: bankName, acctNo: bankAccNo, acctType: bankAccType, branch: bankBranch, city: bankCity, ifscCode: bankIfsc },
      mandateRefId,
      omUMRN: umrn,
      payinMech: paymentMode,
      originTxn: "MKMFONLINE",
      requestRefno,
      camsMandateRefId,
      otpFlag: "B",
      otpFlagValue: `${session.mobile},${session.email || ""}`,
      image: "",
    },
    totalamt: amount,
    CLIENT_IP: "",
    ACTIVITY: "",
    URL: "",
    UTM_SOURCE: "", UTM_MEDIUM: "", UTM_CAMPAIGN: "", UTM_TERM: "", LEAD_URL: "",
    UTM_ADGROUP: "", UTM_NETWORK: "", UTM_MATCHTYPE: "", UTM_DEVICE: "", UTM_PLACEMENT: "",
    UTM_CONTENT: "", UTM_ADPOSITION: "", UTM_LOCATION: "", UTM_CAMPAIGNID: "", UTM_SITELINK: "",
    GAD_SOURCE: "", GAD_CAMPAIGNID: "", GBRAID: "", GCLID: "",
    SESSION_ID: session.investorLink || "",
    SESSION_VALIDATE: "Y",
    SOURCE: { Source: "msite", OS: "Linux" },
    siptype: "",
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/SIPTRXN", enc, session.investorLink || null);
}

// Register UPI autopay mandate — confirmed against a real successful registration (HAR
// www.kotakmf.com3.har). Uses UPI "intent" mode (payervpa left blank): the investor scans/opens
// the returned deeplink with WHICHEVER UPI app they choose, rather than pre-committing to one VPA.
// This avoids the "bank mismatch" failures seen when a specific payervpa was forced — Kotak ties
// the mandate to accountnumber/ifsc (the investor's actual linked bank), not to payervpa.
export async function registerUpiMandate(
  { pan, mobile, amount, startDate, endDate, bankAccNo, bankIfsc, bankName },
  session
) {
  const bare = toUserId(mobile);
  const payload = {
    pan,
    mandatestartdate: startDate,    // YYYY-MM-DD
    mandateenddate: endDate,
    amount: String(amount),
    payervpa: "",
    payername: session.investorName || bare,
    accountnumber: bankAccNo,
    ifsc: bankIfsc,
    RedirectURL: "https://unificationapi.kotakmf.com/KMFUnification/api/Admin/NEWEMANDATECALLBACKURL",
    req_id: "321",
    PayeeBankName: bankName,
    AccType: "SB",
    InvestorName: bare,
    Trxn_Details: "",
    Trxn_Page: "SIP",
    Response_date: "",
    trxnmode: "UPI_NAC",
    USER_TYPE: "UPI-POSTLOGIN",
    intent: "Y",
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/MANDATEREGISTRATION", enc, session.investorLink || null);
}

// Poll UPI mandate registration status
export async function getMandateStatus({ mandateRefNo }, session) {
  const enc = encryptDotnet(JSON.stringify({ cp_mandate_ref_no: mandateRefNo }));
  return kotakPost("/Admin/GETEMANDATESTATUS", enc, session.investorLink || null);
}

// List all SIPs registered for a folio — confirmed from Angular source
// (statement-history/sip-history component). Response shape: { status: { errorflag }, data: [...] }
// where each row has folio, schemeName, amount, frequency, startDate, endDate, schemeCode,
// sipStatus, sipDate, userTrxnNo.
export async function getSipSummary({ folioNo }, session) {
  const payload = {
    reqId: "",
    pan: session.pan || "",
    pekrn: "",
    mobile: session.mobile,
    email: session.email || "",
    amc: "",
    trxnType: "SIP",
    folio: String(folioNo),
  };
  const enc = encryptDotnet(JSON.stringify(payload));
  return kotakPost("/Admin/GETSIPSUMMARY", enc, session.investorLink || null);
}
