import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { sipTools } from "./tools.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/agent", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    const messages = [
      {
        role: "system",
        content: `You are an AI assistant that helps users set up SIP (Systematic Investment Plan) investments at a bank.
When the user describes what SIP they want, extract all the relevant details and call the fill_sip_form tool.
If any required fields are missing or unclear, make a reasonable assumption and note it.
Always call the fill_sip_form tool with whatever information is available.`,
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: sipTools,
      tool_choice: { type: "function", function: { name: "fill_sip_form" } },
    });

    const message = response.choices[0].message;
    const toolCall = message.tool_calls?.[0];

    if (!toolCall) {
      return res.status(500).json({ error: "Agent did not return form data" });
    }

    const formData = JSON.parse(toolCall.function.arguments);

    // Follow-up: ask the agent if it made any assumptions
    const followUp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        ...messages,
        message,
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(formData),
        },
        {
          role: "user",
          content:
            "In one short sentence, summarize what you filled in and mention any assumptions you made.",
        },
      ],
    });

    const summary = followUp.choices[0].message.content;

    return res.json({ formData, summary });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    return res.status(500).json({ error: "Failed to process prompt. Check your API key." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
