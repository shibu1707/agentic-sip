#!/usr/bin/env node
/**
 * submit-sip.js — standalone SIP registration CLI
 *
 * Usage:
 *   node backend/submit-sip.js --amount 500 --months 6 [--day 1] [--start 2026-10-01] [--mode ISIP]
 *
 * Reads KOTAK_PAN, KOTAK_MOBILE, KOTAK_EMAIL from .env or environment.
 * Prompts interactively for OTP and MPIN.
 */

import { createInterface } from "readline";
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dir, ".env") });

import * as kotakApi from "./kotak/api.js";

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { amount: null, months: null, day: "1", start: null, mode: "ISIP", mandate: "" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--amount")  out.amount  = Number(args[++i]);
    if (args[i] === "--months")  out.months  = Number(args[++i]);
    if (args[i] === "--day")     out.day     = args[++i];
    if (args[i] === "--start")   out.start   = args[++i];
    if (args[i] === "--mode")    out.mode    = args[++i];
    if (args[i] === "--mandate") out.mandate = args[++i];
  }
  return out;
}

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

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

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  const pan    = process.env.KOTAK_PAN;
  const mobile = process.env.KOTAK_MOBILE;
  const email  = process.env.KOTAK_EMAIL || "";
  const folio  = process.env.KOTAK_FOLIO || "15461772";

  if (!pan || !mobile) {
    console.error("Error: KOTAK_PAN and KOTAK_MOBILE must be set (in .env or environment).");
    process.exit(1);
  }

  if (!opts.amount || !opts.months) {
    console.error("Usage: node backend/submit-sip.js --amount <INR> --months <n> [--day 1] [--start YYYY-MM-DD] [--mode ISIP|UPI_NAC] [--mandate <ref>]");
    console.error("Example: node backend/submit-sip.js --amount 500 --months 6");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n──────────────────────────────────────────");
  console.log(" Kotak MF SIP Registration");
  console.log("──────────────────────────────────────────");
  console.log(` PAN:    ${pan}`);
  console.log(` Mobile: ${mobile}`);
  console.log(` Folio:  ${folio}`);
  console.log(` Amount: ₹${opts.amount}/month`);
  console.log(` Duration: ${opts.months} months`);
  console.log(` Mode:   ${opts.mode}`);
  console.log("──────────────────────────────────────────\n");

  // Step 1: send OTP
  console.log("Sending OTP...");
  try {
    await kotakApi.checkUserDet(mobile);
    const otpRes = await kotakApi.sendOtpV2({ mobile, pan });
    const status = otpRes?.msgTable?.[0]?.Status || otpRes?.Status;
    if (status && status !== "Y" && status !== "1") {
      console.error("OTP dispatch failed:", JSON.stringify(otpRes));
      rl.close(); process.exit(1);
    }
    console.log("OTP sent to your registered mobile.\n");
  } catch (err) {
    console.error("Failed to send OTP:", err.message);
    rl.close(); process.exit(1);
  }

  // Step 2: get OTP + MPIN from user
  const otp  = (await prompt(rl, "Enter OTP (6 digits): ")).trim();
  const mpin = (await prompt(rl, "Enter MPIN (6 digits): ")).trim();

  // Step 3: validate OTP
  console.log("\nValidating OTP...");
  try {
    const otpResult = await kotakApi.validateOtp({ mobile, otp });
    const s = otpResult?.msgTable?.[0]?.Status || otpResult?.Status;
    if (s && s !== "Y" && s !== "1") {
      console.error("OTP validation failed:", JSON.stringify(otpResult));
      rl.close(); process.exit(1);
    }
  } catch (err) {
    console.error("OTP validation error:", err.message);
    rl.close(); process.exit(1);
  }

  // Step 4: MPIN + session
  console.log("Completing login...");
  let investorLink = null;
  try {
    await kotakApi.getMpinDetByMob({ mobile }).catch(() => {});
    await kotakApi.checkLoginNew({ mobile, mpin }).catch(() => {});
    const insertRes = await kotakApi.insertLoginDetails({ mobile, email });
    investorLink = insertRes?.msgTable?.[0]?.Session || null;
  } catch (err) {
    console.error("Login error:", err.message);
    rl.close(); process.exit(1);
  }

  if (!investorLink) {
    console.error("Login failed: session token not found in INSERTLOGINDETAILS response.");
    rl.close(); process.exit(1);
  }
  console.log("Login successful.\n");

  const session = { pan, mobile, email, investorLink, step: "authenticated" };

  // Step 5: submit SIP
  const startISO    = opts.start || nextFirstOfMonth();
  const kotakStart  = toKotakDate(startISO);
  const kotakEnd    = sipEndDate(startISO, opts.months);

  console.log(`Submitting SIP: ₹${opts.amount}/month from ${kotakStart} to ${kotakEnd}...`);

  try {
    const result = await kotakApi.registerSip(
      {
        folioNo:      folio,
        schemeCode:   144,
        schemeName:   "Kotak ELSS Tax Saver Fund - Gr",
        amount:       opts.amount,
        frequency:    "OM",
        sipDay:       opts.day,
        startDate:    kotakStart,
        endDate:      kotakEnd,
        paymentMode:  opts.mode,
        mandateRefId: opts.mandate,
        umrn:         opts.mandate,
        brokerId:     "ARN-114376",
        euin:         "E207433",
      },
      session
    );

    const msgRow  = result?.msgTable?.[0];
    const success = msgRow?.Status === "Y";

    console.log("\n──────────────────────────────────────────");
    if (success) {
      console.log(" SIP REGISTERED SUCCESSFULLY");
    } else {
      console.log(" SIP REGISTRATION RESULT:");
    }
    console.log("──────────────────────────────────────────");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("SIP registration failed:", err.message);
    rl.close(); process.exit(1);
  }

  rl.close();
}

main().catch(err => { console.error(err); process.exit(1); });
