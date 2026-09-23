# Agentic SIP — Project Notes

## What We Built
A full agentic AI system where users describe a SIP investment in plain English and an AI agent fills the form / executes the flow.

## Architecture
```
User prompt (natural language)
        ↓
Claude Desktop (AI understands intent, calls tools)
        ↓
MCP Server — Node.js (backend tools)
        ↓
OpenAI GPT-4o (generates confirmation via API)
        ↓
Returns mock SIP reference number
```

## Live URLs
- MCP Server (public): https://agentic-sip-production.up.railway.app/mcp
- GitHub repo: https://github.com/shibu1707/agentic-sip

## MCP Tools
| Tool | What it does |
|---|---|
| `get_sip_plans` | Returns list of available mutual funds |
| `calculate_sip` | Calculates maturity amount, returns, total invested |
| `create_sip` | Mock SIP creation — returns reference number via OpenAI |

## How to Run Locally

### Backend (MCP server for Claude Desktop)
```bash
cd backend
node mcp-server.js        # stdio mode for Claude Desktop
# OR
npm run dev               # HTTP mode for testing
```

### Backend (REST API for React frontend)
```bash
cd backend
node server-rest.js
```

### Frontend (React)
```bash
cd frontend
npm run dev
# Open http://localhost:5173
```

## Claude Desktop Config (for local use)
File: `~/Library/Application Support/Claude/claude_desktop_config.json`
```json
{
  "mcpServers": {
    "sip-investment-agent": {
      "command": "node",
      "args": ["/path/to/agentic-sip/backend/mcp-server.js"],
      "env": {
        "OPENAI_API_KEY": "your-key-here"
      }
    }
  }
}
```

## Claude Desktop Config (for public/remote use)
```json
{
  "mcpServers": {
    "sip-investment-agent": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://agentic-sip-production.up.railway.app/mcp"]
    }
  }
}
```

## Environment Variables
```
OPENAI_API_KEY=your-openai-key
PORT=3001
TRANSPORT=http   # set this for HTTP mode (Railway sets PORT automatically)
```

## Tech Stack
- Frontend: React + Vite
- Backend: Node.js + Express + MCP SDK
- AI: OpenAI GPT-4o
- MCP Protocol: @modelcontextprotocol/sdk
- Deployment: Railway (backend), GitHub (source)

## To Make It Production-Ready
1. Integrate with BSE StarMF or MF Utilities API for real SIP orders
2. Add user KYC (PAN + Aadhaar eKYC)
3. Add NACH bank mandate for auto-debit
4. Add user authentication (OAuth2)
5. Get AMFI ARN number or partner with a SEBI-registered RIA
6. Add database (PostgreSQL) for user profiles and transaction history
