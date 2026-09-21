import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import * as kotakApi from "./kotak/api.js";
import { setSession, getSession, clearSession, hasActiveSession } from "./kotak/session.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Step 1: send OTP
app.post("/api/login", async (req, res) => {
  const { pan, mobile, email } = req.body;
  if (!pan || !mobile || !email)
    return res.status(400).json({ error: "pan, mobile, and email are required" });

  try {
    const result = await kotakApi.preLoginSession({ pan, mobile, email });
    const msg = result?.msgTable?.[0];

    if (msg?.Status !== "Y")
      return res.status(401).json({ error: "Login failed", detail: msg });

    const sessionRow = result?.Table?.[0];
    setSession({ pan, mobile, email, kotakSessionId: sessionRow?.SESSION_ID, step: "otp_pending" });

    res.json({ status: "otp_sent", investor_name: sessionRow?.INVESTOR_NAME });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: verify OTP → get Invetorlink
app.post("/api/verify-otp", async (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: "otp is required" });

  const session = getSession();
  if (!session || session.step !== "otp_pending")
    return res.status(401).json({ error: "No pending login. Call /api/login first." });

  try {
    const result = await kotakApi.getMobValidate({
      mobile: session.mobile,
      otp,
      sessionIdFromStep1: session.kotakSessionId,
    });
    const msg = result?.msgTable?.[0];

    if (msg?.Status !== "Y")
      return res.status(401).json({ error: "OTP verification failed", detail: msg });

    const investorLink = result?.Result?.[0]?.Invetorlink;
    setSession({ ...session, investorLink, otp, step: "authenticated" });

    res.json({ status: "authenticated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post("/api/logout", (req, res) => {
  clearSession();
  res.json({ status: "logged_out" });
});

// ─── Data endpoints ───────────────────────────────────────────────────────────

function requireAuth(req, res) {
  const session = getSession();
  if (!hasActiveSession() || session?.step !== "authenticated") {
    res.status(401).json({ error: "Not authenticated. Complete /api/login + /api/verify-otp first." });
    return null;
  }
  return session;
}

// Get portfolio summary (folio + investor name)
app.get("/api/portfolio", async (req, res) => {
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    const result = await kotakApi.getPortfolioDetails(session);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get folio list with current market values
app.get("/api/folios", async (req, res) => {
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    const result = await kotakApi.getFolioList({ mobile: session.mobile, otp: session.otp });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get available SIP schemes
app.get("/api/schemes", async (req, res) => {
  const session = requireAuth(req, res);
  if (!session) return;
  const schemeType = req.query.type || "ALL";
  try {
    const result = await kotakApi.getSchemeNames({ schemeType }, session);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get OTM / bank mandate list for a folio
app.get("/api/otm/:folioNo", async (req, res) => {
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    const result = await kotakApi.getOtmList({ folioNo: req.params.folioNo }, session);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get SIP installment options for a scheme
app.get("/api/sip-installments/:schemeCd", async (req, res) => {
  const session = requireAuth(req, res);
  if (!session) return;
  const { folioNo = "" } = req.query;
  try {
    const result = await kotakApi.getSipInstallments({ schemeCd: req.params.schemeCd, folioNo }, session);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SIP calculation (no API needed) ─────────────────────────────────────────

app.post("/api/calculate", (req, res) => {
  const { amount, duration_months, frequency = "MONTHLY", expected_annual_return = 12 } = req.body;
  if (!amount || !duration_months)
    return res.status(400).json({ error: "amount and duration_months are required" });

  const freqMap = { MONTHLY: 12, WEEKLY: 52, QUARTERLY: 4 };
  const n = freqMap[frequency] || 12;
  const totalInstallments = Math.round((duration_months / 12) * n);
  const r = expected_annual_return / 100 / n;
  const totalInvested = amount * totalInstallments;
  const maturity = amount * ((Math.pow(1 + r, totalInstallments) - 1) / r) * (1 + r);

  res.json({
    installment_amount: amount,
    frequency,
    duration_months,
    total_invested: Math.round(totalInvested),
    estimated_returns: Math.round(maturity - totalInvested),
    maturity_amount: Math.round(maturity),
    assumed_annual_return: expected_annual_return,
  });
});

// ─── Create SIP ───────────────────────────────────────────────────────────────

function toKotakDate(dateStr) {
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const d = new Date(dateStr);
    return `${String(d.getDate()).padStart(2,"0")}-${months[d.getMonth()]}-${d.getFullYear()}`;
  }
  return dateStr;
}

function sipEndDate(startDateStr, durationMonths) {
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const d = new Date(startDateStr);
  d.setMonth(d.getMonth() + durationMonths);
  return `${String(d.getDate()).padStart(2,"0")}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

app.post("/api/sip", async (req, res) => {
  const session = requireAuth(req, res);
  if (!session) return;

  const { folio_no, scheme_cd, amount, frequency, start_date, duration_months, otm_id, bank_account_no } = req.body;
  if (!folio_no || !scheme_cd || !amount || !frequency || !duration_months || !otm_id || !bank_account_no)
    return res.status(400).json({ error: "folio_no, scheme_cd, amount, frequency, duration_months, otm_id, bank_account_no are required" });

  const today = new Date();
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const startISO = start_date || nextMonth.toISOString().split("T")[0];

  try {
    const result = await kotakApi.registerSip(
      {
        folioNo: folio_no,
        schemeCd: scheme_cd,
        amount,
        frequency,
        startDate: toKotakDate(startISO),
        endDate: sipEndDate(startISO, duration_months),
        otmId: otm_id,
        bankAccountNo: bank_account_no,
      },
      session
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ status: "ok", version: "2.0.0-kotak" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Kotak SIP REST API running on http://localhost:${PORT}`));
