export const sipTools = [
  {
    type: "function",
    function: {
      name: "fill_sip_form",
      description:
        "Extract and fill a SIP (Systematic Investment Plan) form with all details from the user's prompt.",
      parameters: {
        type: "object",
        properties: {
          fund_name: {
            type: "string",
            description: "Name of the mutual fund (e.g. HDFC Flexi Cap, SBI Bluechip, Nifty 50 Index Fund)",
          },
          fund_category: {
            type: "string",
            enum: ["equity", "debt", "hybrid", "index", "elss"],
            description: "Category of the fund",
          },
          amount: {
            type: "number",
            description: "Monthly SIP amount in INR (Indian Rupees)",
          },
          frequency: {
            type: "string",
            enum: ["daily", "weekly", "monthly", "quarterly"],
            description: "How often the SIP installment should be deducted",
          },
          duration_months: {
            type: "number",
            description: "Total duration of the SIP in months (e.g. 36 for 3 years)",
          },
          start_date: {
            type: "string",
            description:
              "Start date of the SIP in YYYY-MM-DD format. If not mentioned, default to first of next month.",
          },
          goal: {
            type: "string",
            description: "Investment goal such as retirement, house purchase, education, wealth creation",
          },
        },
        required: ["amount", "frequency"],
      },
    },
  },
];
