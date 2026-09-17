import { useState } from "react";
import axios from "axios";
import "./App.css";

const EXAMPLES = [
  "₹5000/month in HDFC Flexi Cap for 3 years",
  "Start a SIP of 10000 monthly in Nifty 50 index fund for retirement",
  "Invest 2500 weekly in SBI Bluechip for 2 years, goal is house purchase",
];

const EMPTY_FORM = {
  fund_name: "",
  fund_category: "",
  amount: "",
  frequency: "monthly",
  duration_months: "",
  start_date: "",
  goal: "",
};

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [filledFields, setFilledFields] = useState(new Set());
  const [submitted, setSubmitted] = useState(false);

  async function handleAgent() {
    if (!prompt.trim()) return;
    setLoading(true);
    setError("");
    setSummary("");
    setSubmitted(false);

    try {
      const { data } = await axios.post("http://localhost:3001/api/agent", { prompt });
      const fd = data.formData;

      const newForm = { ...EMPTY_FORM };
      const filled = new Set();

      Object.entries(fd).forEach(([key, val]) => {
        if (val !== undefined && val !== null && val !== "") {
          newForm[key] = String(val);
          filled.add(key);
        }
      });

      setForm(newForm);
      setFilledFields(filled);
      setSummary(data.summary);
    } catch (err) {
      setError(err.response?.data?.error || "Something went wrong. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  function handleChange(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleReset() {
    setForm(EMPTY_FORM);
    setFilledFields(new Set());
    setSummary("");
    setError("");
    setPrompt("");
    setSubmitted(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <>
      <div className="header">
        <h1>SIP Investment Portal</h1>
        <p>Describe your investment in plain English — the AI agent will fill the form for you.</p>
      </div>

      {/* Agent prompt */}
      <div className="agent-box">
        <h2>AI Agent</h2>
        <div className="agent-input-row">
          <textarea
            placeholder="e.g. Start a SIP of ₹5000/month in HDFC Flexi Cap for 3 years"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleAgent();
              }
            }}
          />
          <button onClick={handleAgent} disabled={loading || !prompt.trim()}>
            {loading ? "Filling..." : "Fill Form"}
          </button>
        </div>

        <div className="examples">
          <span>Try:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => setPrompt(ex)}>
              {ex}
            </button>
          ))}
        </div>

        {summary && <div className="agent-summary">{summary}</div>}
        {error && <div className="agent-error">{error}</div>}
      </div>

      {/* SIP Form */}
      <div className="form-box">
        <h2>SIP Details</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="form-field full-width">
              <label>Fund Name</label>
              <input
                type="text"
                placeholder="e.g. HDFC Flexi Cap Fund"
                value={form.fund_name}
                onChange={(e) => handleChange("fund_name", e.target.value)}
                className={filledFields.has("fund_name") ? "filled" : ""}
              />
            </div>

            <div className="form-field">
              <label>Fund Category</label>
              <select
                value={form.fund_category}
                onChange={(e) => handleChange("fund_category", e.target.value)}
                className={filledFields.has("fund_category") ? "filled" : ""}
              >
                <option value="">Select category</option>
                <option value="equity">Equity</option>
                <option value="debt">Debt</option>
                <option value="hybrid">Hybrid</option>
                <option value="index">Index</option>
                <option value="elss">ELSS (Tax Saving)</option>
              </select>
            </div>

            <div className="form-field">
              <label>Investment Amount (₹)</label>
              <input
                type="number"
                placeholder="e.g. 5000"
                value={form.amount}
                onChange={(e) => handleChange("amount", e.target.value)}
                className={filledFields.has("amount") ? "filled" : ""}
                required
              />
            </div>

            <div className="form-field">
              <label>Frequency</label>
              <select
                value={form.frequency}
                onChange={(e) => handleChange("frequency", e.target.value)}
                className={filledFields.has("frequency") ? "filled" : ""}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
            </div>

            <div className="form-field">
              <label>Duration (months)</label>
              <input
                type="number"
                placeholder="e.g. 36"
                value={form.duration_months}
                onChange={(e) => handleChange("duration_months", e.target.value)}
                className={filledFields.has("duration_months") ? "filled" : ""}
              />
            </div>

            <div className="form-field">
              <label>Start Date</label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => handleChange("start_date", e.target.value)}
                className={filledFields.has("start_date") ? "filled" : ""}
              />
            </div>

            <div className="form-field full-width">
              <label>Investment Goal</label>
              <input
                type="text"
                placeholder="e.g. Retirement, Education, House purchase"
                value={form.goal}
                onChange={(e) => handleChange("goal", e.target.value)}
                className={filledFields.has("goal") ? "filled" : ""}
              />
            </div>
          </div>

          <div className="submit-row">
            <button type="button" className="btn-reset" onClick={handleReset}>
              Reset
            </button>
            <button type="submit" className="btn-submit">
              Confirm &amp; Start SIP
            </button>
          </div>
        </form>

        {submitted && (
          <div className="success-banner">
            SIP submitted successfully! Your investment of ₹{form.amount} ({form.frequency}) has been scheduled.
          </div>
        )}
      </div>
    </>
  );
}
