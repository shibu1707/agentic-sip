import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SIP_PLANS = [
  { fund_name: "HDFC Flexi Cap Fund", category: "equity", risk: "High", min_sip: 500 },
  { fund_name: "SBI Bluechip Fund", category: "equity", risk: "Moderately High", min_sip: 500 },
  { fund_name: "Nifty 50 Index Fund", category: "index", risk: "Moderate", min_sip: 100 },
  { fund_name: "ICICI Prudential Debt Fund", category: "debt", risk: "Low", min_sip: 1000 },
  { fund_name: "Axis ELSS Tax Saver Fund", category: "elss", risk: "High", min_sip: 500 },
  { fund_name: "Mirae Asset Hybrid Fund", category: "hybrid", risk: "Moderate", min_sip: 1000 },
];

function createMcpServer() {
  const server = new McpServer({
    name: "sip-investment-agent",
    version: "1.0.0",
  });

  server.tool(
    "get_sip_plans",
    "DEMO TOOL: Get available mutual fund SIP plans with categories, risk levels, and minimum investment amounts. No real financial data — demonstration only.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ plans: SIP_PLANS }, null, 2) }],
    })
  );

  server.tool(
    "calculate_sip",
    "DEMO TOOL: Calculate SIP maturity amount, total investment, and estimated returns. Demonstration calculator — no real financial advice.",
    {
      amount: z.number().describe("SIP installment amount in INR"),
      frequency: z.enum(["daily", "weekly", "monthly", "quarterly"]).describe("How often the SIP is deducted"),
      duration_months: z.number().describe("Duration in months"),
      expected_annual_return: z.number().optional().describe("Expected annual return % (default: 12)"),
    },
    async ({ amount, frequency, duration_months, expected_annual_return = 12 }) => {
      const frequencyMap = { daily: 365, weekly: 52, monthly: 12, quarterly: 4 };
      const installmentsPerYear = frequencyMap[frequency] || 12;
      const totalInstallments = Math.round((duration_months / 12) * installmentsPerYear);
      const ratePerInstallment = expected_annual_return / 100 / installmentsPerYear;
      const totalInvested = amount * totalInstallments;
      const maturityAmount =
        amount *
        ((Math.pow(1 + ratePerInstallment, totalInstallments) - 1) / ratePerInstallment) *
        (1 + ratePerInstallment);
      const estimatedReturns = maturityAmount - totalInvested;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              monthly_investment: `₹${amount}`,
              frequency,
              duration: `${duration_months} months (${(duration_months / 12).toFixed(1)} years)`,
              total_invested: `₹${Math.round(totalInvested).toLocaleString("en-IN")}`,
              estimated_returns: `₹${Math.round(estimatedReturns).toLocaleString("en-IN")}`,
              maturity_amount: `₹${Math.round(maturityAmount).toLocaleString("en-IN")}`,
              assumed_annual_return: `${expected_annual_return}%`,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "create_sip",
    "DEMO TOOL: Simulates creating a SIP for demonstration only. Returns a mock reference number. No real money is moved, no real account is created, no real transaction occurs.",
    {
      fund_name: z.string().optional().describe("Name of the mutual fund"),
      amount: z.number().describe("SIP installment amount in INR"),
      frequency: z.enum(["daily", "weekly", "monthly", "quarterly"]).describe("Frequency of SIP deduction"),
      duration_months: z.number().describe("Duration in months"),
      start_date: z.string().optional().describe("Start date in YYYY-MM-DD format"),
      goal: z.string().optional().describe("Investment goal (e.g. retirement, house)"),
    },
    async ({ fund_name, amount, frequency, duration_months, start_date, goal }) => {
      const today = new Date();
      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      const effectiveStartDate = start_date || nextMonth.toISOString().split("T")[0];

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: `Generate a short mock SIP confirmation message (2-3 lines) for a DEMO app:
Fund: ${fund_name || "Not specified"}
Amount: ₹${amount} ${frequency}
Duration: ${duration_months} months
Start Date: ${effectiveStartDate}
Goal: ${goal || "Wealth creation"}
Include a mock reference number like SIP-DEMO-XXXX. Clearly state this is a demo.`,
          },
        ],
        max_tokens: 150,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "demo_success",
              reference_number: `SIP-DEMO-${Date.now().toString().slice(-6)}`,
              sip_details: {
                fund_name: fund_name || "Not specified",
                amount: `₹${amount}`,
                frequency,
                duration_months,
                start_date: effectiveStartDate,
                goal: goal || "Wealth creation",
              },
              confirmation: completion.choices[0].message.content,
              note: "DEMO ONLY — No real transaction was made.",
            }, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

const isHttp = process.env.TRANSPORT === "http" || process.env.PORT;

if (isHttp) {
  // HTTP mode — for public deployment
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_, res) => res.json({ status: "ok" }));

  app.all("/mcp", async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => {
    console.log(`MCP HTTP server running on http://localhost:${PORT}/mcp`);
  });
} else {
  // stdio mode — for local Claude Desktop
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
