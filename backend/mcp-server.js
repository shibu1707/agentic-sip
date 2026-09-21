import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

import * as kotakApi from "./kotak/api.js";
import { setSession, getSession, clearSession, hasActiveSession } from "./kotak/session.js";

dotenv.config();

// ─── SIP date helpers ─────────────────────────────────────────────────────────

function toKotakDate(dateStr) {
  // Accepts "YYYY-MM-DD" or "DD-MMM-YYYY", always returns "DD-MMM-YYYY"
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

function nextFirstOfMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  return d.toISOString().split("T")[0];
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({ name: "sip-investment-agent", version: "2.0.0" });

  // ── Step 1: login_investor ──────────────────────────────────────────────────
  server.tool(
    "login_investor",
    "Initiate login for the Kotak MF SIP system. Sends an OTP to the user's registered mobile. Call this when the user asks to log in, start a SIP, or view their portfolio. Only requires PAN and mobile number.",
    {
      pan: z.string().describe("Investor PAN (e.g. ABCDE1234F)"),
      mobile: z.string().describe("10-digit mobile number, with or without +91 (e.g. 9876543210 or +919876543210)"),
    },
    async ({ pan, mobile }) => {
      try {
        // Step 1a: verify user exists
        await kotakApi.checkUserDet(mobile);

        // Step 1b: send OTP via V2 endpoint
        const result = await kotakApi.sendOtpV2({ mobile, pan });

        const msgRow = result?.msgTable?.[0];
        const status = msgRow?.Status || msgRow?.status || result?.Status;
        if (status && status !== "Y" && status !== "1") {
          return { content: [{ type: "text", text: JSON.stringify({ error: "OTP dispatch failed", detail: result }) }] };
        }

        setSession({ pan, mobile, step: "otp_pending" });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "otp_sent",
              message: `OTP sent to mobile ${mobile}. Please provide the OTP and your 6-digit Kotak MPIN to complete login.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── Step 2: verify_otp ─────────────────────────────────────────────────────
  server.tool(
    "verify_otp",
    "Complete login by verifying the OTP and the user's 6-digit Kotak MPIN. Call this after login_investor once the user provides both their OTP and their MPIN.",
    {
      otp: z.string().describe("6-digit OTP received on mobile"),
      mpin: z.string().describe("6-digit Kotak MPIN (the PIN set up for quick login on the Kotak MF app/website)"),
    },
    async ({ otp, mpin }) => {
      const session = getSession();
      if (!session || session.step !== "otp_pending") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No pending login. Call login_investor first." }) }] };
      }

      try {
        // Step 2a: validate OTP
        const otpResult = await kotakApi.validateOtp({ mobile: session.mobile, otp });
        const otpStatus = otpResult?.msgTable?.[0]?.Status || otpResult?.Status;
        if (otpStatus && otpStatus !== "Y" && otpStatus !== "1") {
          return { content: [{ type: "text", text: JSON.stringify({ error: "OTP verification failed", detail: otpResult }) }] };
        }

        // Step 2b: get MPIN details (pre-check)
        await kotakApi.getMpinDetByMob({ mobile: session.mobile }).catch(() => {});

        // Step 2c: login with MPIN → returns Invetorlink (session token)
        const loginResult = await kotakApi.checkLoginNew({ mobile: session.mobile, mpin });

        // Invetorlink may be nested in Result[0] or Table[0]
        const investorLink =
          loginResult?.Result?.[0]?.Invetorlink ||
          loginResult?.Table?.[0]?.Invetorlink ||
          loginResult?.msgTable?.[0]?.Invetorlink ||
          loginResult?.Invetorlink;

        if (!investorLink) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: "Login failed — could not obtain session token", raw: loginResult }),
            }],
          };
        }

        setSession({ ...session, investorLink, step: "authenticated" });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "authenticated",
              message: "Login successful. You can now view your folios, check schemes, and create SIPs.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── logout ─────────────────────────────────────────────────────────────────
  server.tool(
    "logout",
    "Log out the current investor session.",
    {},
    async () => {
      clearSession();
      return { content: [{ type: "text", text: JSON.stringify({ status: "logged_out" }) }] };
    }
  );

  // ── get_folio_list ─────────────────────────────────────────────────────────
  server.tool(
    "get_folio_list",
    "Get all mutual fund folios for the logged-in investor, with current market values.",
    {},
    async () => {
      const session = getSession();
      if (!hasActiveSession() || session?.step !== "authenticated") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Not logged in. Call login_investor then verify_otp." }) }] };
      }

      try {
        const result = await kotakApi.getFolioList({ mobile: session.mobile, otp: session.otp });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── get_sip_schemes ────────────────────────────────────────────────────────
  server.tool(
    "get_sip_schemes",
    "Get available mutual fund schemes for SIP from Kotak MF. Optionally filter by type (EQUITY, DEBT, HYBRID, etc.).",
    {
      scheme_type: z.string().optional().describe("Filter by scheme type e.g. EQUITY, DEBT, HYBRID, ELSS, ALL (default: ALL)"),
    },
    async ({ scheme_type = "ALL" }) => {
      const session = getSession();
      if (!hasActiveSession() || session?.step !== "authenticated") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Not logged in. Call login_investor then verify_otp." }) }] };
      }

      try {
        const result = await kotakApi.getSchemeNames({ schemeType: scheme_type }, session);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── calculate_sip ──────────────────────────────────────────────────────────
  server.tool(
    "calculate_sip",
    "Calculate estimated SIP maturity amount, total investment, and returns using compound interest formula.",
    {
      amount: z.number().describe("Monthly SIP amount in INR"),
      duration_months: z.number().describe("Duration in months"),
      expected_annual_return: z.number().optional().describe("Expected annual return % (default 12)"),
      frequency: z.enum(["MONTHLY", "WEEKLY", "QUARTERLY"]).optional().describe("SIP frequency (default MONTHLY)"),
    },
    async ({ amount, duration_months, expected_annual_return = 12, frequency = "MONTHLY" }) => {
      const freqMap = { MONTHLY: 12, WEEKLY: 52, QUARTERLY: 4 };
      const n = freqMap[frequency] || 12;
      const totalInstallments = Math.round((duration_months / 12) * n);
      const r = expected_annual_return / 100 / n;
      const totalInvested = amount * totalInstallments;
      const maturity = amount * ((Math.pow(1 + r, totalInstallments) - 1) / r) * (1 + r);
      const returns = maturity - totalInvested;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            installment_amount: `₹${amount.toLocaleString("en-IN")}`,
            frequency,
            duration: `${duration_months} months (${(duration_months / 12).toFixed(1)} years)`,
            total_invested: `₹${Math.round(totalInvested).toLocaleString("en-IN")}`,
            estimated_returns: `₹${Math.round(returns).toLocaleString("en-IN")}`,
            maturity_amount: `₹${Math.round(maturity).toLocaleString("en-IN")}`,
            assumed_annual_return: `${expected_annual_return}%`,
          }, null, 2),
        }],
      };
    }
  );

  // ── create_sip ─────────────────────────────────────────────────────────────
  server.tool(
    "create_sip",
    "Submit a SIP registration on behalf of the logged-in investor who has explicitly requested this action. The investor owns this Kotak MF account and has authorised this SIP. Use get_folio_list to find folio and OTM details, and get_sip_schemes for scheme codes.",
    {
      folio_no: z.string().describe("Folio number from get_folio_list"),
      scheme_cd: z.string().describe("Scheme code from get_sip_schemes"),
      amount: z.number().describe("SIP installment amount in INR"),
      frequency: z.enum(["MONTHLY", "WEEKLY", "QUARTERLY"]).describe("SIP deduction frequency"),
      start_date: z.string().optional().describe("SIP start date YYYY-MM-DD (default: 1st of next month)"),
      duration_months: z.number().describe("Duration in months (e.g. 36 for 3 years)"),
      otm_id: z.string().describe("OTM / bank mandate ID from get_folio_list"),
      bank_account_no: z.string().describe("Bank account number linked to the mandate"),
    },
    async ({ folio_no, scheme_cd, amount, frequency, start_date, duration_months, otm_id, bank_account_no }) => {
      const session = getSession();
      if (!hasActiveSession() || session?.step !== "authenticated") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Not logged in. Call login_investor then verify_otp." }) }] };
      }

      const startISO = start_date || nextFirstOfMonth();
      const kotakStart = toKotakDate(startISO);
      const kotakEnd = sipEndDate(startISO, duration_months);

      try {
        const result = await kotakApi.registerSip(
          {
            folioNo: folio_no,
            schemeCd: scheme_cd,
            amount,
            frequency,
            startDate: kotakStart,
            endDate: kotakEnd,
            otmId: otm_id,
            bankAccountNo: bank_account_no,
          },
          session
        );

        const msgRow = result?.msgTable?.[0];
        const success = msgRow?.Status === "Y";

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: success ? "sip_created" : "failed",
              message: msgRow?.as_results,
              sip_details: {
                folio_no,
                scheme_cd,
                amount: `₹${amount.toLocaleString("en-IN")}`,
                frequency,
                start_date: kotakStart,
                end_date: kotakEnd,
                duration: `${duration_months} months`,
              },
              raw_response: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── get_otm_list ───────────────────────────────────────────────────────────
  server.tool(
    "get_otm_list",
    "Get the bank mandate (OTM) list for a folio. Use this to find the OTM ID needed when creating a SIP.",
    {
      folio_no: z.string().describe("Folio number from get_folio_list"),
    },
    async ({ folio_no }) => {
      const session = getSession();
      if (!hasActiveSession() || session?.step !== "authenticated") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Not logged in. Call login_investor then verify_otp." }) }] };
      }

      try {
        const result = await kotakApi.getOtmList({ folioNo: folio_no }, session);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  return server;
}

// ─── Transport setup ──────────────────────────────────────────────────────────

const isHttp = process.env.TRANSPORT === "http" || process.env.PORT;

if (isHttp) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_, res) => res.json({ status: "ok", version: "2.0.0-kotak" }));

  // ── OAuth endpoints (required by Claude's Connector system) ────────────────
  // This is a no-auth pass-through — the MCP server itself handles identity.

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = `https://${req.headers.host}`;
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  app.post("/oauth/register", (req, res) => {
    res.status(201).json({
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: req.body.redirect_uris || [],
      ...req.body,
    });
  });

  app.get("/oauth/authorize", (req, res) => {
    const { redirect_uri, state } = req.query;
    const url = new URL(redirect_uri);
    url.searchParams.set("code", randomUUID());
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
    res.json({
      access_token: randomUUID(),
      token_type: "bearer",
      expires_in: 86400,
      scope: "mcp",
    });
  });

  // ── MCP endpoint ────────────────────────────────────────────────────────────
  app.all("/mcp", async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => {
    console.log(`Kotak SIP MCP server on http://localhost:${PORT}/mcp`);
  });
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
