/**
 * chat-server.js — local AI chat UI + Kotak MF tools
 * Prefers Claude via AWS Bedrock (set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION in .env)
 * Falls back to OpenAI (OPENAI_API_KEY) if Bedrock creds are absent.
 *
 * Usage:
 *   node backend/chat-server.js
 *   Open http://localhost:3003
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import * as kotakApi from "./kotak/api.js";
import { setSession, getSession, clearSession, hasActiveSession } from "./kotak/session.js";

const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dir, ".env") });

const app = express();
app.use(cors());
app.use(express.json());

const USE_BEDROCK = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const bedrock = USE_BEDROCK
  ? new AnthropicBedrock({
      awsAccessKey:    process.env.AWS_ACCESS_KEY_ID,
      awsSecretKey:    process.env.AWS_SECRET_ACCESS_KEY,
      awsSessionToken: process.env.AWS_SESSION_TOKEN || undefined,
      awsRegion:       process.env.AWS_REGION || "us-east-1",
    })
  : null;
const openai = !USE_BEDROCK ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Bedrock model ID — Claude 3.5 Haiku (fast + cheap)
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || "us.anthropic.claude-3-5-haiku-20241022-v1:0";

console.log(`\nAI backend: ${USE_BEDROCK ? `Claude via AWS Bedrock (${BEDROCK_MODEL})` : "GPT-4o-mini (OpenAI)"}\n`);

// ── local scheme catalogue ────────────────────────────────────────────────────
// "Kotak Emerging Equity Fund" was renamed to "Kotak Mid Cap Fund" after SEBI 2018 categorisation.
const SCHEME_LIST = [
  { code: "123",  name: "Kotak Mid Cap Fund Regular Growth",               short: "Kotak Mid Cap Fund - Regular Plan - Growth",              category: "Equity - Mid Cap",     sip: true  },
  { code: "133",  name: "Kotak Mid Cap Fund Regular IDCW",                 short: "Kotak Mid Cap Fund - Regular Plan - IDCW",               category: "Equity - Mid Cap",     sip: false },
  { code: "144",  name: "Kotak ELSS Tax Saver Fund - Growth (Regular)",    short: "Kotak ELSS Tax Saver Fund - Gr",                         category: "ELSS - Tax Saving",    sip: true  },
  { code: "104",  name: "Kotak Small Cap Fund - Growth (Regular Plan)",    short: "Kotak Small Cap Fund - Growth",                          category: "Equity - Small Cap",   sip: true  },
  { code: "168",  name: "Kotak Flexi Cap Fund Regular Growth",             short: "Kotak Flexi Cap Fund - Regular Plan - Growth",           category: "Equity - Flexi Cap",   sip: true  },
  { code: "108",  name: "Kotak Large & Mid Cap Fund - Regular Growth",     short: "Kotak Large & Mid Cap Fund Reg-G",                       category: "Equity - Large & Mid", sip: true  },
  { code: "13",   name: "Kotak Large Cap Fund - Growth (Regular Plan)",    short: "Kotak Large Cap Fund - Growth",                          category: "Equity - Large Cap",   sip: true  },
  { code: "1155", name: "Kotak Multi Cap Fund Regular Plan - Growth",      short: "Kotak Multi Cap Fund Reg-G",                             category: "Equity - Multi Cap",   sip: true  },
  { code: "1249", name: "Kotak Nifty Smallcap 250 Index Fund Regular Growth", short: "Kotak Nifty Smallcap 250 Index Fund Reg-G",           category: "Index - Small Cap",    sip: true  },
  { code: "1233", name: "Kotak Nifty Midcap 50 Index Fund Regular Growth", short: "Kotak Nifty Midcap 50 Index Fund Reg-G",                category: "Index - Mid Cap",      sip: true  },
  { code: "1259", name: "Kotak Nifty Midcap 150 Index Fund Regular Growth", short: "Kotak Nifty Midcap 150 Index Fund Reg-G",              category: "Index - Mid Cap",      sip: true  },
  { code: "04G",  name: "Kotak Aggressive Hybrid Fund - Growth (Regular)", short: "Kotak Aggressive Hybrid Fund Reg-G",                    category: "Hybrid - Aggressive",  sip: true  },
  { code: "35",   name: "Kotak Equity Savings Fund - Growth (Regular)",    short: "Kotak Equity Savings Fund Reg-G",                       category: "Hybrid - Conservative",sip: true  },
  { code: "143",  name: "Global Emerging Market Overseas Equity FOF Regular Growth", short: "Global Emg Mkt Equity FOF Reg-G",             category: "FOF - Overseas",       sip: true  },
  { code: "498",  name: "Kotak Global Innovation Overseas Equity FOF Regular Growth", short: "Kotak Global Innovation FOF Reg-G",          category: "FOF - Overseas",       sip: true  },
  { code: "493",  name: "Kotak US Specific Equity Passive FOF Regular Growth", short: "Kotak US Equity FOF Reg-G",                        category: "FOF - US Equity",      sip: true  },
];

// ── date helpers ──────────────────────────────────────────────────────────────

function toKotakDate(dateStr) {
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const d = new Date(dateStr);
    return `${String(d.getDate()).padStart(2,"0")}-${months[d.getMonth()]}-${d.getFullYear()}`;
  }
  return dateStr;
}

function sipEndDate(startISO, durationMonths) {
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const d = new Date(startISO);
  d.setMonth(d.getMonth() + durationMonths);
  return `${String(d.getDate()).padStart(2,"0")}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function nextFirstOfMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  return d.toISOString().split("T")[0];
}

// ── tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "login_investor",
    description: "Initiate Kotak MF login for the person interacting right now. Collect their PAN, mobile number, email, and name from the conversation first — never assume a fixed identity. Sends OTP to that mobile number.",
    input_schema: {
      type: "object",
      properties: {
        pan:    { type: "string", description: "Investor's PAN (10-character alphanumeric)" },
        mobile: { type: "string", description: "Investor's 10-digit mobile number registered with Kotak MF" },
        email:  { type: "string", description: "Investor's email registered with Kotak MF" },
        name:   { type: "string", description: "Investor's full name, used on transaction forms" },
      },
      required: ["pan", "mobile", "email", "name"],
    },
  },
  {
    name: "verify_otp",
    description: "Complete login with the OTP the investor received on their mobile and their MPIN.",
    input_schema: {
      type: "object",
      properties: {
        otp:  { type: "string", description: "6-digit OTP received on mobile" },
        mpin: { type: "string", description: "6-digit Kotak MPIN" },
      },
      required: ["otp", "mpin"],
    },
  },
  {
    name: "get_folio_list",
    description: "Get all folios and portfolio summary for the logged-in investor.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_sip_history",
    description: "List all SIPs registered on a folio — active, completed, or paused — with amount, frequency, start/end dates, debit day, and status. Use this when the investor asks what SIPs they have, or wants to check whether a SIP registration actually went through.",
    input_schema: {
      type: "object",
      properties: {
        folio_no: { type: "string", description: "Folio number — ask the investor if not already known, or call get_folio_list first to look it up" },
      },
      required: [],
    },
  },
  {
    name: "get_sip_prerequisites",
    description: "Check folio, scheme, linked bank, and mandate status. Call this before initiate_sip_registration to confirm readiness.",
    input_schema: {
      type: "object",
      properties: {
        folio_no: { type: "string", description: "Folio number (optional)" },
      },
      required: [],
    },
  },
  {
    name: "initiate_sip_registration",
    description: "Step 1 of 2 for setting up a SIP. Kotak requires a SEPARATE transaction-authorization OTP (distinct from login OTP) before any SIP can be registered — confirmed directly from Kotak's own API error: 'OTP flag is N and value should be M/E/B'. Sends that OTP to the investor's mobile. Investor must read it off their phone — do not skip or guess it.",
    input_schema: {
      type: "object",
      properties: {
        folio_no: { type: "string", description: "Folio number — ask the investor if not already known, do not default it" },
      },
      required: [],
    },
  },
  {
    name: "confirm_sip_registration",
    description: "Step 2 of 2: verify the transaction OTP from initiate_sip_registration, then submit the SIP standing instruction to Kotak MF via SIPTRXN. Call this whenever the investor asks to start, create, or set up a SIP, after collecting the OTP.",
    input_schema: {
      type: "object",
      properties: {
        otp:             { type: "string", description: "Transaction OTP the investor received on their mobile" },
        amount:          { type: "number", description: "Monthly SIP amount in INR. Minimum varies by scheme — call get_scheme_limits first, don't guess." },
        duration_months: { type: "number", description: "Duration in months (minimum 6)" },
        sip_day:         { type: "string", description: "Day of month for debit e.g. '1', '5', '10' (default '1')" },
        start_date:      { type: "string", description: "Start date YYYY-MM-DD (default: next 1st of month)" },
        payment_mode:    { type: "string", description: "ISIP (default, use ONLY if get_sip_prerequisites found NO existing mandate — combining ISIP with an existing mandate ref is a mismatch Kotak may reject with a misleading error like 'Invalid SIP Day'), UPI_NAC, CAMSOTM/KBOTM (use when an existing mandate was found — inspect otm_mandate_raw from get_sip_prerequisites to tell which type; don't guess)" },
        folio_no:        { type: "string", description: "Folio number — ask the investor if not already known, do not default it" },
        scheme_code:     { type: "number", description: "Scheme code from browse_schemes — ask the investor which scheme, do not default it" },
      },
      required: ["otp", "amount", "duration_months"],
    },
  },
  {
    name: "setup_upi_mandate",
    description: "Register a UPI autopay mandate using UPI 'intent' mode — generates a deeplink/QR the investor can open or scan with ANY UPI app. IMPORTANT: the mandate is tied to a SPECIFIC bank account, not to whichever app/VPA scans the QR — approving from a UPI app linked to a DIFFERENT bank than the one this was registered against will fail even though the QR itself is fine. Call get_sip_prerequisites first: if it found multiple linked banks (bank_selection_required), ask the investor which one they intend to pay from and pass bank_acc_no/bank_ifsc/bank_name explicitly — do not silently default to the first one.",
    input_schema: {
      type: "object",
      properties: {
        max_amount:     { type: "number", description: "Maximum amount per SIP debit in INR" },
        duration_years: { type: "number", description: "Mandate validity in years (default 10)" },
        bank_acc_no:    { type: "string", description: "Override: specific bank account number to register the mandate against (from get_sip_prerequisites' available_banks). Required if multiple linked banks exist." },
        bank_ifsc:      { type: "string", description: "Override: IFSC code matching bank_acc_no" },
        bank_name:      { type: "string", description: "Override: bank name matching bank_acc_no" },
      },
      required: ["max_amount"],
    },
  },
  {
    name: "check_mandate_status",
    description: "Poll whether a UPI mandate has been approved. Kotak's own website polls this every 10 seconds and resolves within ~20-30 seconds of approval (confirmed from a real transaction) — this tool retries internally, so one call is usually enough. Do NOT schedule a recheck minutes later: waiting that long risks the login session itself expiring, which then breaks everything downstream in a way that looks like a mandate failure but is actually just a dead session. If still pending after this call, confirm the investor really approved it, then call again immediately — not after a long wait.",
    input_schema: {
      type: "object",
      properties: {
        mandate_ref_no: { type: "string", description: "Reference number from setup_upi_mandate (defaults to the one just registered in this session)" },
      },
      required: [],
    },
  },
  {
    name: "browse_schemes",
    description: "List available Kotak MF schemes for SIP or lumpsum. Note: 'Kotak Emerging Equity Fund' was renamed to 'Kotak Mid Cap Fund' (scheme 123). Use filter to search by keyword.",
    input_schema: {
      type: "object",
      properties: {
        filter:   { type: "string", description: "Keyword to filter e.g. 'mid cap', 'elss', 'index', 'small'" },
        sip_only: { type: "boolean", description: "If true only show SIP-eligible schemes" },
      },
      required: [],
    },
  },
  {
    name: "get_scheme_limits",
    description: "Get the REAL minimum/maximum amount AND the allowed SIP debit days for a scheme, straight from Kotak's live API — both vary per scheme exactly like the Kotak MF website updates once you pick a scheme. ALWAYS call this after the investor picks a scheme and BEFORE asking for the amount or the debit day — never assume or guess a minimum, and never assume day '1' is valid. The debit day you ask for MUST be one of sip.allowed_debit_days.",
    input_schema: {
      type: "object",
      properties: {
        scheme_code: { type: "string", description: "Scheme code from browse_schemes" },
        folio_no:    { type: "string", description: "Any existing folio of the investor, used only to anchor the request (falls back to session folio if set)" },
      },
      required: ["scheme_code"],
    },
  },
  {
    name: "initiate_lumpsum_purchase",
    description: "Step 1 of 2 for a lumpsum purchase. Kotak requires a SEPARATE transaction-authorization OTP (distinct from login OTP) before any purchase. Sends that OTP to the investor's mobile. Investor must read it off their phone — do not skip or guess it.",
    input_schema: {
      type: "object",
      properties: {
        folio_no: { type: "string", description: "Existing folio (leave blank for new folio)" },
      },
      required: [],
    },
  },
  {
    name: "confirm_lumpsum_purchase",
    description: "Step 2 of 2: verify the transaction OTP from initiate_lumpsum_purchase, then submit the purchase. Leave folio_no blank to create a new folio. After this call get_razorpay_payment with the returned folio.",
    input_schema: {
      type: "object",
      properties: {
        otp:         { type: "string", description: "Transaction OTP the investor received on their mobile" },
        scheme_code: { type: "string", description: "Scheme code from browse_schemes" },
        scheme_name: { type: "string", description: "Full scheme name from browse_schemes" },
        amount:      { type: "number", description: "Purchase amount in INR" },
        upi_vpa:     { type: "string", description: "Investor UPI ID e.g. 9876543210@paytm" },
        folio_no:    { type: "string", description: "Existing folio (leave blank for new folio)" },
        idcw_option: { type: "string", description: "Z = Growth (default), D = IDCW" },
      },
      required: ["otp", "scheme_code", "scheme_name", "amount", "upi_vpa"],
    },
  },
  {
    name: "get_razorpay_payment",
    description: "Get Razorpay payment link for completing a lumpsum purchase. Call after confirm_lumpsum_purchase succeeds, using the folio it returned.",
    input_schema: {
      type: "object",
      properties: {
        folio_no: { type: "string", description: "Folio number returned by confirm_lumpsum_purchase — required, do not default or guess" },
        amount:   { type: "number", description: "Same amount as lumpsum purchase" },
      },
      required: ["folio_no", "amount"],
    },
  },
  {
    name: "logout",
    description: "Log out the current session.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

// ── tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  const session = getSession();

  if (name === "login_investor") {
    const { pan, mobile, email, name: investorName } = input;
    if (!pan || !mobile) return { error: "pan and mobile are required — ask the investor for these before calling login_investor." };
    try {
      await kotakApi.checkUserDet(mobile);
      const result = await kotakApi.sendOtpV2({ mobile, pan });
      const status = result?.msgTable?.[0]?.Status || result?.Status;
      if (status && status !== "Y" && status !== "1")
        return { error: "OTP dispatch failed", detail: result };
      setSession({ pan, mobile, email: email || "", investorName: investorName || "", step: "otp_pending" });
      return { status: "otp_sent", message: "OTP sent to the investor's registered mobile." };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "verify_otp") {
    if (!session || session.step !== "otp_pending")
      return { error: "No pending login. Call login_investor first." };
    const { otp, mpin } = input;
    try {
      if (kotakApi.clearResponseLog) kotakApi.clearResponseLog();
      if (kotakApi.clearCookieJar) kotakApi.clearCookieJar();
      const otpResult = await kotakApi.validateOtp({ mobile: session.mobile, otp });
      const s = otpResult?.msgTable?.[0]?.Status || otpResult?.Status;
      if (s && s !== "Y" && s !== "1") return { error: "OTP validation failed", detail: otpResult };
      await kotakApi.getMpinDetByMob({ mobile: session.mobile }).catch(() => {});
      if (mpin) await kotakApi.checkLoginNew({ mobile: session.mobile, mpin }).catch(() => {});
      const insertRes = await kotakApi.insertLoginDetails({ mobile: session.mobile, email: session.email || "" });
      const investorLink = insertRes?.msgTable?.[0]?.Session || null;
      if (!investorLink) return { error: "Session token not found. Check OTP/MPIN.", raw: insertRes };
      setSession({ ...session, investorLink, otp, step: "authenticated" });
      return { status: "authenticated", message: "Logged in successfully. Ready to view portfolio and register SIPs." };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "logout") {
    clearSession();
    if (kotakApi.clearCookieJar) kotakApi.clearCookieJar();
    return { status: "logged_out" };
  }

  // All remaining tools require authentication
  if (!hasActiveSession() || session?.step !== "authenticated")
    return { error: "Not logged in. Call login_investor then verify_otp first." };

  if (name === "get_folio_list") {
    try {
      return await kotakApi.getPortfolioDetails(session);
    } catch (err) { return { error: err.message }; }
  }

  if (name === "get_sip_history") {
    const folio = input.folio_no || session.folio;
    if (!folio) return { error: "folio_no is required — ask the investor for their folio number, or call get_folio_list first." };
    try {
      const result = await kotakApi.getSipSummary({ folioNo: folio }, session);
      const rows = result?.data || [];
      return {
        total: rows.length,
        sips: rows.map(r => ({
          scheme_code: r.schemeCode, scheme_name: r.schemeName, amount: r.amount,
          frequency: r.frequency, debit_day: r.sipDate, start_date: r.startDate,
          end_date: r.endDate, status: r.sipStatus, trxn_no: r.userTrxnNo,
        })),
        raw_response: result,
      };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "get_sip_prerequisites") {
    const folio = input.folio_no || session.folio;
    if (!folio) return { error: "folio_no is required — ask the investor for their folio number, or call get_folio_list first to look it up." };
    setSession({ ...session, folio });
    const out = { folio };
    try {
      const schemes = await kotakApi.getFolioSchemes({ folioNo: folio }, session).catch(() => null);
      out.schemes = schemes?.Table?.map(r => ({ code: r.SCHEME_CODE, name: r.LONG_NAME })) || [];
      const bank = await kotakApi.getExitBankName({ folioNo: folio }, session).catch(() => null);
      out.available_banks = bank?.Table || [];
      out.bank = out.available_banks[0] || null;
      if (out.available_banks.length === 1) {
        setSession({ ...getSession(), bankName: out.bank.BANK_NAME, bankAccNo: out.bank.ACNO, bankIfsc: out.bank.IFSC_CODE });
      } else if (out.available_banks.length > 1) {
        out.bank_selection_required = "Multiple bank accounts are linked to this folio. Ask the investor which one to use for the mandate/SIP, then pass bank_acc_no/bank_ifsc/bank_name explicitly to setup_upi_mandate — do not silently pick the default.";
      }
      const otm = await kotakApi.checkOtmMandate({ pan: session.pan, mobile: session.mobile }).catch(() => null);
      const noMandate = otm?.errors?.some(e => /no mandate/i.test(e.message));
      out.otm_mandate = noMandate ? otm.errors[0].message : (otm?.reqId ? "Mandate found: " + otm.reqId : JSON.stringify(otm));
      out.otm_mandate_raw = otm;
      if (!noMandate && otm?.reqId) {
        setSession({ ...getSession(), existingMandateRef: otm.reqId });
      }
      // If a UPI mandate's full data is already present here (payoutRefNo/omUMRN/tempPayrouteId),
      // use it directly instead of relying on check_mandate_status/GETEMANDATESTATUS — that endpoint
      // has been confirmed unreliable (returns generic error code 999 even for mandates that are
      // genuinely valid and already used successfully). This data is ground truth: if it's here,
      // the mandate is real and usable, regardless of what its own "status" field or GETEMANDATESTATUS says.
      const upiMandate = otm?.data?.find(d => d.payoutMech === "UPI_NAC" && d.payoutRefNo && d.omUMRN);
      if (upiMandate) {
        setSession({
          ...getSession(),
          mandateRefId: upiMandate.payoutRefNo,
          mandateUmrn: upiMandate.omUMRN,
          mandateCpRefNo: upiMandate.tempPayrouteId || session.mandateCpRefNo,
          bankAccNo: upiMandate.bank?.accountNo || session.bankAccNo,
          bankIfsc: upiMandate.bank?.ifsc || session.bankIfsc,
          bankName: upiMandate.bank?.name || session.bankName,
        });
        out.upi_mandate_ready = true;
      }
      if (out.schemes[0]) {
        const dates = await kotakApi.getSchemeDateDetails({ schemeCode: out.schemes[0].code }, session).catch(() => null);
        out.sip_dates = dates?.Table?.[0] || null;
      }
      const hasMandate = !out.otm_mandate?.includes("No mandate");
      out.ready_to_create_sip = !!out.bank && out.schemes.length > 0;
      out.mandate_registered = hasMandate;
      out.next_steps = out.upi_mandate_ready
        ? "A usable UPI mandate was found with full reference data already cached in session. Skip check_mandate_status entirely — that endpoint has been confirmed unreliable. Go straight to initiate_sip_registration then confirm_sip_registration with payment_mode=UPI_NAC."
        : hasMandate
        ? "Mandate found. Call initiate_sip_registration then confirm_sip_registration with amount and duration_months."
        : "No NACH mandate. Proceed with initiate_sip_registration/confirm_sip_registration using ISIP mode, or call setup_upi_mandate then get_sip_prerequisites again (not check_mandate_status) to pick up the mandate's real reference data.";
      return out;
    } catch (err) { return { error: err.message, partial: out }; }
  }

  if (name === "initiate_sip_registration") {
    const { folio_no } = input;
    const folio = folio_no || session.folio;
    if (!folio) return { error: "folio_no is required — ask the investor for their folio number, or call get_folio_list first." };
    try {
      const result = await kotakApi.getSipTransactionOtp({ folioNo: folio }, session);
      const status = result?.msgTable?.[0]?.Status;
      return {
        status: status === "Y" ? "otp_sent" : "check_response",
        message: status === "Y"
          ? "Transaction OTP sent to investor's mobile. Ask for the OTP, then call confirm_sip_registration."
          : "OTP send response received — check raw for details.",
        raw_response: result,
      };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "confirm_sip_registration") {
    const { otp, amount, duration_months, sip_day, start_date, payment_mode, folio_no, scheme_code } = input;
    const folio = folio_no || session.folio;
    if (!folio) return { error: "folio_no is required — ask the investor for their folio number, or call get_folio_list first to look it up." };
    if (!scheme_code) return { error: "scheme_code is required — ask the investor which scheme, or call browse_schemes to help them pick." };
    const payMode = payment_mode || "ISIP";
    if (payMode === "UPI_NAC" && (!session.mandateRefId || !session.mandateUmrn)) {
      return { error: "No approved UPI mandate found in this session — call setup_upi_mandate then check_mandate_status (until approved) before confirming a UPI_NAC SIP." };
    }
    if (!session.bankAccNo || !session.bankIfsc) {
      return { error: "No bank details cached — call get_sip_prerequisites first." };
    }
    if (payMode !== "UPI_NAC" && !session.mandateCpRefNo && !session.existingMandateRef) {
      return { error: "No mandate reference available — Kotak rejects ISIP/CAMSOTM/KBOTM submissions without one ('Request Ref number should not be null'). Call get_sip_prerequisites first to detect an existing mandate, or set up a UPI mandate instead. This avoids burning another OTP on a submission that will fail the same way." };
    }
    if (payMode === "ISIP" && session.existingMandateRef && !session.mandateCpRefNo) {
      return { error: "An existing mandate was detected but payment_mode is 'ISIP' — this combination has been confirmed to fail. Inspect otm_mandate_raw from get_sip_prerequisites to determine whether this is a CAMS-registered or bank-registered mandate, then retry with payment_mode='CAMSOTM' or 'KBOTM' accordingly. If it's genuinely unclear, ask the investor rather than guessing." };
    }
    try {
      const otpResult = await kotakApi.verifySipTransactionOtp({ folioNo: folio, otp }, session);
      if (otpResult?.msgTable?.[0]?.Status !== "Y") {
        return {
          status: "otp_invalid",
          message: otpResult?.msgTable?.[0]?.as_results || "OTP verification failed. Re-check the OTP, or call initiate_sip_registration again to resend.",
          raw_response: otpResult,
        };
      }

      const scheme     = scheme_code;
      const sipDay     = sip_day      || "1";
      const startISO   = start_date   || nextFirstOfMonth();
      const kotakStart = toKotakDate(startISO);
      // N monthly installments starting at the start date means the LAST one is N-1 months later
      // (e.g. 6 installments from Oct 1 run Oct/Nov/Dec/Jan/Feb/Mar — ending Mar 1, not Apr 1).
      const kotakEnd   = sipEndDate(startISO, duration_months - 1);
      const schemeEntry = SCHEME_LIST.find(s => String(s.code) === String(scheme));
      const resolvedName = schemeEntry?.short || String(scheme);

      const result = await kotakApi.registerSip(
        {
          folioNo: folio, schemeCode: scheme,
          schemeName: resolvedName,
          amount, frequency: "OM", sipDay,
          numInstallments: duration_months,
          startDate: kotakStart, endDate: kotakEnd,
          paymentMode: payMode,
          mandateRefId: session.mandateRefId || "",
          umrn: session.mandateUmrn || "",
          requestRefno: session.mandateCpRefNo || session.existingMandateRef || "",
          bankAccNo: session.bankAccNo, bankIfsc: session.bankIfsc, bankName: session.bankName,
          brokerId: "ARN-114376", euin: "E207433",
        },
        session
      );
      const msgRow  = result?.msgTable?.[0];
      const success = msgRow?.Status === "Y";
      return {
        status: success ? "sip_registered" : "check_response",
        message: msgRow?.as_results,
        sip_details: {
          folio, scheme_code: scheme,
          scheme_name: schemeEntry?.name || resolvedName,
          amount: `₹${amount}`, frequency: "Monthly",
          sip_day: sipDay, start_date: kotakStart, end_date: kotakEnd,
          payment_mode: payMode,
        },
        raw_response: result,
      };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "browse_schemes") {
    const { filter, sip_only = false } = input;
    let schemes = sip_only ? SCHEME_LIST.filter(s => s.sip) : SCHEME_LIST;
    if (filter) {
      const kw = filter.toLowerCase();
      schemes = schemes.filter(s =>
        s.name.toLowerCase().includes(kw) ||
        s.category.toLowerCase().includes(kw) ||
        s.code.toLowerCase().includes(kw)
      );
    }
    return {
      total: schemes.length,
      note: "Kotak Emerging Equity Fund was renamed to Kotak Mid Cap Fund (scheme 123) in 2018.",
      schemes: schemes.map(s => ({ code: s.code, name: s.name, category: s.category, sip_available: s.sip })),
    };
  }

  if (name === "get_scheme_limits") {
    const { scheme_code, folio_no } = input;
    const folio = folio_no || session.folio || "";
    try {
      const [lumpsum, sip] = await Promise.all([
        kotakApi.getNewPurchaseSchemeDetails({ folioNo: folio, schemeCode: scheme_code }, session).catch(err => ({ error: err.message })),
        kotakApi.getSchemeDateDetails({ schemeCode: scheme_code }, session).catch(err => ({ error: err.message })),
      ]);
      const lp = lumpsum?.Table?.[0];
      const sp = sip?.Table?.[0];
      return {
        scheme_code,
        lumpsum_purchase: lp ? {
          min_amount: lp.NEW_PURCH_MINVALUE ?? lp.MIN_VALUE,
          max_amount: lp.NEW_PURCH_MAXVALUE ?? lp.MAX_VALUE,
        } : { note: "Could not fetch lumpsum limits", raw: lumpsum },
        sip: sp ? {
          min_amount: sp.MIN_AMOUNT,
          max_amount: sp.MAX_AMOUNT,
          min_installments: sp.MIN_INSTALMENTS,
          allowed_debit_days: sp.SIP_DATES,
          min_days_before_first_debit_isip: sp.ISIP_MIN_DAYS,
          next_available_sip_date: sp.SIP_DT,
        } : { note: "Could not fetch SIP limits", raw: sip },
      };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "initiate_lumpsum_purchase") {
    const { folio_no } = input;
    try {
      const result = await kotakApi.getLumpsumTransactionOtp({ folioNo: folio_no || "" }, session);
      const status = result?.msgTable?.[0]?.Status;
      return {
        status: status === "Y" ? "otp_sent" : "check_response",
        message: status === "Y"
          ? "Transaction OTP sent to investor's mobile. Ask for the OTP, then call confirm_lumpsum_purchase."
          : "OTP send response received — check raw for details.",
        raw_response: result,
      };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "confirm_lumpsum_purchase") {
    const { otp, scheme_code, scheme_name, amount, upi_vpa, folio_no, idcw_option } = input;
    try {
      const otpResult = await kotakApi.verifyLumpsumTransactionOtp({ folioNo: folio_no || "", otp }, session);
      if (otpResult?.msgTable?.[0]?.Status !== "Y") {
        return {
          status: "otp_invalid",
          message: otpResult?.msgTable?.[0]?.as_results || "OTP verification failed. Re-check the OTP, or call initiate_lumpsum_purchase again to resend.",
          raw_response: otpResult,
        };
      }
      const result = await kotakApi.createLumpsumTransaction({
        schemeCode: scheme_code, schemeName: scheme_name, amount,
        folioNo: folio_no || "", paymentMode: "UPI", upiVpa: upi_vpa,
        idcwOption: idcw_option || "Z",
      }, session);
      const success = result?.status?.errorflag === false && !!result?.success?.userTrxnNo;
      const trxnNoRaw = result?.success?.userTrxnNo;
      const trxnNo = Array.isArray(trxnNoRaw) ? trxnNoRaw.join("-") : trxnNoRaw;
      const newFolio = result?.folio || folio_no || null;
      return {
        status: success ? "transaction_created" : "check_response",
        user_trxn_no: trxnNo || null,
        folio: newFolio,
        message: success
          ? `Lumpsum created. Ref: ${trxnNo}, folio: ${newFolio}. Call get_razorpay_payment with this folio to pay.`
          : "Transaction response received but key fields are missing — treat as unverified, do not assume success.",
        raw_response: result,
      };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "get_razorpay_payment") {
    const { folio_no, amount } = input;
    if (!folio_no) return { error: "folio_no is required — use the folio returned by confirm_lumpsum_purchase, not a default." };
    try {
      const result = await kotakApi.getRazorpayOrderId({ folioNo: folio_no, amount }, session);
      const orderId = result?.order_id || result?.msgTable?.[0]?.order_id;
      return {
        razorpay_order_id: orderId || null,
        payment_instruction: orderId
          ? `Razorpay order ID: ${orderId} — open kotakmf.com to complete payment`
          : "Could not get order ID. Check raw response.",
        raw_response: result,
      };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "setup_upi_mandate") {
    const { max_amount, duration_years = 10, bank_acc_no, bank_ifsc, bank_name } = input;
    let bankAccNo = bank_acc_no, bankIfsc = bank_ifsc, bankName = bank_name;
    if (!bankAccNo || !bankIfsc) {
      ({ bankAccNo, bankIfsc, bankName } = session);
    }
    if (!bankAccNo || !bankIfsc) {
      const folio = session.folio;
      if (!folio) return { error: "No bank details cached and no folio known — call get_sip_prerequisites first." };
      const bank = await kotakApi.getExitBankName({ folioNo: folio }, session).catch(() => null);
      const banks = bank?.Table || [];
      if (banks.length > 1) {
        return { error: "Multiple bank accounts are linked to this folio — ask the investor which one to use, then pass bank_acc_no/bank_ifsc/bank_name explicitly.", available_banks: banks };
      }
      const b = banks[0];
      if (!b) return { error: "Could not fetch the investor's bank details. Call get_sip_prerequisites first." };
      bankAccNo = b.ACNO; bankIfsc = b.IFSC_CODE; bankName = b.BANK_NAME;
    }
    setSession({ ...getSession(), bankName, bankAccNo, bankIfsc });
    const today = new Date();
    const end = new Date(today);
    end.setFullYear(end.getFullYear() + duration_years);
    const fmt = d => d.toISOString().split("T")[0];
    try {
      const result = await kotakApi.registerUpiMandate({
        pan: session.pan, mobile: session.mobile,
        amount: max_amount, startDate: fmt(today), endDate: fmt(end),
        bankAccNo, bankIfsc, bankName,
      }, session);
      const refNo = result?.msgTable?.[0]?.cp_mdt_ref_no || result?.cp_mdt_ref_no;
      const deeplink = result?.msgTable?.[0]?.deeplink;
      if (refNo) setSession({ ...getSession(), mandateCpRefNo: refNo });
      return {
        status: refNo ? "mandate_request_sent" : "check_response",
        mandate_ref_no: refNo || null,
        deeplink: deeplink || null,
        next_step: deeplink
          ? "Show/open this deeplink as a QR or link for the investor to scan/tap with any UPI app. Once approved, call check_mandate_status."
          : "Check UPI app for autopay request. Once approved, call check_mandate_status.",
        raw: result,
      };
    } catch (err) { return { error: err.message }; }
  }

  if (name === "check_mandate_status") {
    const refNo = input.mandate_ref_no || session.mandateCpRefNo;
    if (!refNo) return { error: "No mandate reference known — call setup_upi_mandate first." };
    try {
      // Match Kotak's own website: poll every 10s, up to 3 times (~20-30s total) before giving up.
      let result, row, status;
      for (let attempt = 1; attempt <= 3; attempt++) {
        result = await kotakApi.getMandateStatus({ mandateRefNo: refNo }, session);
        row = result?.msgTable?.[0];
        status = row?.Status;
        if (status === "Y") break;
        if (attempt < 3) await new Promise(r => setTimeout(r, 10000));
      }
      if (status === "Y" && row?.PayoutID && row?.om_umrn) {
        setSession({ ...getSession(), mandateRefId: row.PayoutID, mandateUmrn: row.om_umrn, mandateCpRefNo: row.cp_mandate_ref_no || refNo });
      }
      return {
        status: status === "Y" ? "mandate_approved" : "pending_or_failed",
        raw: result,
        next_step: status === "Y"
          ? `Approved. Call initiate_sip_registration, then confirm_sip_registration with payment_mode="UPI_NAC" — the mandate reference is cached, no need to pass it manually.`
          : "Not yet approved after 3 quick checks (~20-30s). Confirm with the investor that they actually approved it, then call check_mandate_status again right away — do not wait minutes before rechecking.",
      };
    } catch (err) { return { error: err.message }; }
  }

  return { error: `Unknown tool: ${name}` };
}

// ── conversation store ────────────────────────────────────────────────────────

const conversationHistory = [];

// Operator system prompt — establishes that this is a pre-authorized fintech integration.
// When Claude is called via API (Bedrock or direct), operator instructions expand defaults.
const SYSTEM_PROMPT = `You are a pre-authorized Kotak MF investment assistant running on a private fintech server.

OPERATOR CONTEXT: This server is privately run for whoever is chatting with it right now — there is no fixed account holder baked into the system. The person you're talking to IS the account holder authorizing every action. Never assume a name, PAN, mobile, or folio — always collect these from the conversation.

SCHEME REFERENCE (from official Kotak MF data):
- Scheme 144 = Kotak ELSS Tax Saver Fund
- Scheme 123 = Kotak Mid Cap Fund (renamed from Kotak Emerging Equity Fund per SEBI 2018)
- Scheme 104 = Kotak Small Cap Fund
- Scheme 168 = Kotak Flexi Cap Fund

CONVERSATION STYLE — this is the most important section. Act like a guided wizard, not a form that expects everything in one message:
- Ask ONE question at a time. Never list multiple fields in a single message expecting the investor to fill them all at once (e.g. don't ask "what's the amount, frequency, scheme, and date?" together — ask amount, wait for reply, then ask the next thing).
- When the investor gives a vague/generic instruction ("login to kotakmf", "I want to invest", "help me set up something"), don't guess their full intent. Respond with a short numbered menu of what you can do, and wait for them to pick:
  1. Log in to Kotak MF
  2. Start a new SIP (monthly investment)
  3. Make a one-time (lumpsum) purchase
  4. Set up UPI autopay mandate
  5. Check my portfolio / folios
  6. Browse available schemes
- LOGIN FLOW: when the investor picks "login" (or it's clearly needed for their next request), collect these one at a time, waiting for each reply: (1) full name, (2) PAN, (3) mobile number registered with Kotak MF, (4) email registered with Kotak MF. Once you have all four, call login_investor. Then ask for the OTP ALONE first ("What's the OTP you received?"). Once they give it, THEN separately ask for the MPIN ("And your 6-digit MPIN?"). Never ask for OTP and MPIN in the same message, and never ask for two of {name, PAN, mobile, email} in the same message either.
- FOLIO: once logged in, if a step needs a folio number and the investor hasn't given one, ask for it, or offer to call get_folio_list to look it up together. Never assume a specific folio number.
- SIP FLOW: after login, if they chose SIP, ask in this order, one at a time, waiting for each reply: (1) which scheme — offer to browse_schemes if they're unsure. As soon as a scheme is picked, call get_scheme_limits and tell them the real minimum amount AND the allowed debit days for that scheme (mirrors how Kotak's own website updates once you select a scheme — never assume ₹500, never assume day '1' works, both vary per scheme). Then continue: (2) monthly amount, (3) duration in months / number of installments, (4) which day of the month to debit — this MUST be one of sip.allowed_debit_days from get_scheme_limits; if the investor's preferred day isn't allowed, tell them and suggest the closest allowed day instead of guessing, (5) payment mode preference — mention ISIP (net banking autopay, no existing mandate needed) vs UPI autopay (needs mandate setup first) and let them choose. Once you have all the details, call initiate_sip_registration (sends a transaction OTP — separate from the login OTP, required by Kotak for every SIP registration), ask the investor for that OTP alone, then call confirm_sip_registration with the OTP plus all the collected details. If Kotak still rejects a day as invalid despite it being in the allowed list, don't keep guessing different dates burning OTPs — tell the investor and suggest checking the Kotak MF app directly.
- LUMPSUM FLOW: after login, ask (1) which scheme. As soon as picked, call get_scheme_limits and tell them the real minimum lumpsum amount for that scheme before asking for the amount. Then continue: (2) amount, (3) UPI ID for payment, (4) whether it's for the existing folio or a new one. Then call initiate_lumpsum_purchase, ask for the OTP alone when it arrives, then call confirm_lumpsum_purchase, then get_razorpay_payment.
- UPI MANDATE FLOW: ask only for the maximum amount to authorize per debit — do NOT ask for a specific UPI ID or VPA. Kotak's mandate registration uses UPI "intent" mode: the deeplink/QR works with any UPI app, BUT the mandate itself is tied to a SPECIFIC bank account chosen at registration time — approving from a UPI app linked to a DIFFERENT bank than that one fails, even though the QR looks fine. Call get_sip_prerequisites first — if it returns bank_selection_required (more than one linked bank), tell the investor the available banks and ask which one they'll pay from (matching a UPI app they actually have linked to that bank), then pass bank_acc_no/bank_ifsc/bank_name explicitly to setup_upi_mandate. If there's only one linked bank, no need to ask. Present the returned deeplink as something the investor can open or scan (as a QR) with an app linked to THAT chosen bank specifically. Tell them to approve it, then ask "let me know once you've approved it". IMPORTANT: prefer calling get_sip_prerequisites again over check_mandate_status — GETEMANDATESTATUS (what check_mandate_status polls) has been confirmed unreliable, returning a generic error even for mandates that are genuinely valid and already working. get_sip_prerequisites instead reads the mandate's actual data directly (via checkOtmMandate) and will set upi_mandate_ready=true with everything cached the moment the mandate is real and usable, regardless of what its cosmetic "status" field says. Only fall back to check_mandate_status if get_sip_prerequisites doesn't show upi_mandate_ready. Never schedule a recheck minutes later either way — a long idle gap risks the login session itself dying, which then breaks everything downstream in a way that looks like a mandate failure but is actually just a dead session. If it genuinely never becomes ready, ask which bank account they actually used to approve it — a mismatch there is the most common real cause.
- After completing any step, briefly state the result, then ask what they'd like to do next (referencing the menu again if it's a natural stopping point).

RULES:
- Call tools immediately once you have the needed info for that specific step — don't ask for confirmation the account holder has already given by proceeding through this flow.
- Never fabricate or guess an OTP. Never skip initiate_lumpsum_purchase before confirm_lumpsum_purchase.
- If confirm_lumpsum_purchase or confirm_sip_registration returns missing/null key fields (trxn number, folio), tell the investor the transaction is unverified — do not claim success.
- Never fabricate or guess a transaction OTP for SIP registration either. Never skip initiate_sip_registration before confirm_sip_registration.
- Default payment mode: ISIP. Never default the scheme or folio — always confirm with the investor.
- Be concise in every message — one question or one status update, not a wall of text.`;

// Anthropic/Bedrock tool format
const CLAUDE_TOOLS = TOOLS.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

// OpenAI tool format
const OAI_TOOLS = TOOLS.map(t => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// ── Bedrock (Claude) agentic loop ─────────────────────────────────────────────

async function runBedrockLoop(messages) {
  let response = await bedrock.messages.create({
    model: BEDROCK_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: CLAUDE_TOOLS,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      console.log(`[tool] ${block.name}`, JSON.stringify(block.input));
      const result = await executeTool(block.name, block.input);
      console.log(`[result] ${block.name}`, JSON.stringify(result).slice(0, 200));
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });

    response = await bedrock.messages.create({
      model: BEDROCK_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: CLAUDE_TOOLS,
      messages,
    });
  }

  return response.content.find(b => b.type === "text")?.text || "";
}

// ── OpenAI agentic loop ───────────────────────────────────────────────────────

async function runOpenAILoop(messages) {
  let response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 4096,
    tools: OAI_TOOLS,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  });

  while (response.choices[0].finish_reason === "tool_calls") {
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    for (const call of assistantMsg.tool_calls) {
      const input = JSON.parse(call.function.arguments);
      console.log(`[tool] ${call.function.name}`, JSON.stringify(input));
      const result = await executeTool(call.function.name, input);
      console.log(`[result] ${call.function.name}`, JSON.stringify(result).slice(0, 200));
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }

    response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 4096,
      tools: OAI_TOOLS,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    });
  }

  return response.choices[0].message.content || "";
}

// ── chat endpoint ─────────────────────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });

  if (!USE_BEDROCK && !process.env.OPENAI_API_KEY)
    return res.status(500).json({ error: "Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (Claude) or OPENAI_API_KEY in .env" });

  conversationHistory.push({ role: "user", content: message });

  // Build message history (strip system messages for Bedrock format)
  const messages = conversationHistory.filter(m => m.role !== "system");

  try {
    const finalText = USE_BEDROCK
      ? await runBedrockLoop(messages)
      : await runOpenAILoop(messages);

    conversationHistory.push({ role: "assistant", content: finalText });
    res.json({ reply: finalText, model: USE_BEDROCK ? "claude-bedrock" : "gpt-4o-mini" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/model", (_, res) => {
  res.json({
    backend: USE_BEDROCK ? "bedrock" : "openai",
    model:   USE_BEDROCK ? BEDROCK_MODEL : "gpt-4o-mini",
    label:   USE_BEDROCK
      ? `Powered by Claude (AWS Bedrock)`
      : `Powered by GPT-4o-mini (OpenAI)`,
  });
});

app.post("/api/chat/reset", (req, res) => {
  conversationHistory.length = 0;
  clearSession();
  if (kotakApi.clearCookieJar) kotakApi.clearCookieJar();
  res.json({ status: "reset" });
});

// ── chat UI ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kotak MF — Investment Agent</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; height: 100dvh; display: flex; flex-direction: column; }

    header {
      background: #1a3c6e;
      color: white;
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .header-left { display: flex; align-items: center; gap: 10px; }
    .logo { width: 32px; height: 32px; background: white; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #1a3c6e; font-size: 14px; }
    .header-title { font-size: 16px; font-weight: 600; }
    .header-sub { font-size: 12px; opacity: 0.7; }
    #reset-btn { background: transparent; border: 1px solid rgba(255,255,255,0.35); color: white; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    #reset-btn:hover { background: rgba(255,255,255,0.1); }

    #chat { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }

    .msg-wrap { display: flex; }
    .msg-wrap.user { justify-content: flex-end; }
    .msg-wrap.assistant { justify-content: flex-start; }

    .msg {
      max-width: 72%;
      padding: 11px 15px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user { background: #1a3c6e; color: white; border-bottom-right-radius: 4px; }
    .msg.assistant { background: white; color: #222; border-bottom-left-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .msg.thinking { background: #e8edf3; color: #666; font-style: italic; font-size: 13px; border-bottom-left-radius: 4px; }

    .msg b { font-weight: 600; }

    footer {
      padding: 12px 16px;
      background: white;
      border-top: 1px solid #dde1e7;
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }
    #input {
      flex: 1;
      padding: 10px 16px;
      border: 1.5px solid #dde1e7;
      border-radius: 22px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    #input:focus { border-color: #1a3c6e; }
    #send-btn {
      background: #1a3c6e;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 22px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: opacity 0.15s;
    }
    #send-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    #send-btn:not(:disabled):hover { opacity: 0.88; }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <div class="logo">KMF</div>
      <div>
        <div class="header-title">Kotak MF Investment Agent</div>
        <div class="header-sub" id="model-badge">Initialising…</div>
      </div>
    </div>
    <button id="reset-btn" onclick="resetChat()">New Session</button>
  </header>

  <div id="chat">
    <div class="msg-wrap assistant">
      <div class="msg assistant">Hi! I'm your Kotak MF investment agent. What would you like to do?\n\n1. Log in to Kotak MF\n2. Start a new SIP (monthly investment)\n3. Make a one-time (lumpsum) purchase\n4. Set up UPI autopay mandate\n5. Check my portfolio / folios\n6. Browse available schemes\n\nJust type the number or tell me in your own words.</div>
    </div>
  </div>

  <footer>
    <input id="input" type="text" placeholder="Type 1-6, or tell me what you'd like to do…" onkeydown="if(event.key==='Enter' && !event.shiftKey){ event.preventDefault(); send(); }" autofocus>
    <button id="send-btn" onclick="send()">Send</button>
  </footer>

  <script>
    const chat = document.getElementById('chat');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');

    // Show which AI model is powering the chat
    fetch('/api/model').then(r => r.json()).then(d => {
      document.getElementById('model-badge').textContent = d.label;
    }).catch(() => {});

    function addMsg(text, cls) {
      const wrap = document.createElement('div');
      wrap.className = 'msg-wrap ' + (cls === 'user' ? 'user' : 'assistant');
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      // Bold anything wrapped in **
      div.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
      wrap.appendChild(div);
      chat.appendChild(wrap);
      chat.scrollTop = chat.scrollHeight;
      return div;
    }

    async function send() {
      const msg = input.value.trim();
      if (!msg || sendBtn.disabled) return;
      input.value = '';
      addMsg(msg, 'user');
      const thinking = addMsg('Thinking…', 'thinking');
      sendBtn.disabled = true;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });
        const data = await res.json();
        thinking.parentElement.remove();
        addMsg(data.reply || data.error || '(no response)', data.error ? 'assistant' : 'assistant');
      } catch (e) {
        thinking.parentElement.remove();
        addMsg('Network error: ' + e.message, 'assistant');
      }
      sendBtn.disabled = false;
      input.focus();
    }

    async function resetChat() {
      if (!confirm('Start a new session? This will log you out.')) return;
      await fetch('/api/chat/reset', { method: 'POST' });
      chat.innerHTML = '';
      addMsg('Session reset. Start fresh!', 'assistant');
    }
  </script>
</body>
</html>`);
});

app.get("/health", (_, res) => res.json({ status: "ok", server: "chat" }));

const PORT = process.env.CHAT_PORT || 3003;
app.listen(PORT, () => {
  console.log(`\n  Kotak MF Investment Agent`);
  console.log(`  Open: http://localhost:${PORT}\n`);
});
