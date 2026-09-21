import { useState } from "react";
import axios from "axios";
import "./App.css";

const API = "http://localhost:3001";

const STEPS = { LOGIN: "login", OTP: "otp", SIP: "sip", CONFIRM: "confirm" };

export default function App() {
  const [step, setStep] = useState(STEPS.LOGIN);

  // Login state
  const [pan, setPan]       = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail]   = useState("");
  const [investorName, setInvestorName] = useState("");

  // OTP state
  const [otp, setOtp] = useState("");

  // SIP form state
  const [folioNo, setFolioNo]         = useState("");
  const [schemeCd, setSchemeCd]       = useState("");
  const [schemeName, setSchemeName]   = useState("");
  const [amount, setAmount]           = useState("");
  const [frequency, setFrequency]     = useState("MONTHLY");
  const [durationMonths, setDuration] = useState("");
  const [otmId, setOtmId]             = useState("");
  const [bankAccNo, setBankAccNo]     = useState("");
  const [startDate, setStartDate]     = useState("");

  // Calculated projection
  const [projection, setProjection] = useState(null);

  // Result
  const [sipResult, setSipResult] = useState(null);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  function clearError() { setError(""); }

  // ── Step 1: Login ────────────────────────────────────────────────────────────
  async function handleLogin(e) {
    e.preventDefault();
    clearError();
    setLoading(true);
    try {
      const mobileFormatted = mobile.startsWith("+91") ? mobile : `+91${mobile}`;
      const { data } = await axios.post(`${API}/api/login`, {
        pan: pan.toUpperCase().trim(),
        mobile: mobileFormatted,
        email: email.trim(),
      });
      setInvestorName(data.investor_name || "");
      setStep(STEPS.OTP);
    } catch (err) {
      setError(err.response?.data?.error || "Login failed. Check your details.");
    } finally {
      setLoading(false);
    }
  }

  // ── Step 2: OTP ──────────────────────────────────────────────────────────────
  async function handleOtp(e) {
    e.preventDefault();
    clearError();
    setLoading(true);
    try {
      await axios.post(`${API}/api/verify-otp`, { otp });
      setStep(STEPS.SIP);
    } catch (err) {
      setError(err.response?.data?.error || "Invalid OTP. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Step 3: Calculate projection ────────────────────────────────────────────
  async function calculateProjection() {
    if (!amount || !durationMonths) return;
    try {
      const { data } = await axios.post(`${API}/api/calculate`, {
        amount: Number(amount),
        duration_months: Number(durationMonths),
        frequency,
      });
      setProjection(data);
    } catch { /* silent */ }
  }

  // ── Step 3: Submit SIP ───────────────────────────────────────────────────────
  async function handleSip(e) {
    e.preventDefault();
    clearError();
    setLoading(true);
    try {
      const { data } = await axios.post(`${API}/api/sip`, {
        folio_no: folioNo.trim(),
        scheme_cd: schemeCd.trim(),
        amount: Number(amount),
        frequency,
        duration_months: Number(durationMonths),
        start_date: startDate || undefined,
        otm_id: otmId.trim(),
        bank_account_no: bankAccNo.trim(),
      });
      setSipResult(data);
      setStep(STEPS.CONFIRM);
    } catch (err) {
      setError(err.response?.data?.error || "SIP creation failed.");
    } finally {
      setLoading(false);
    }
  }

  // ── Step 4: Reset ────────────────────────────────────────────────────────────
  async function handleReset() {
    await axios.post(`${API}/api/logout`).catch(() => {});
    setPan(""); setMobile(""); setEmail(""); setInvestorName("");
    setOtp("");
    setFolioNo(""); setSchemeCd(""); setSchemeName(""); setAmount("");
    setFrequency("MONTHLY"); setDuration(""); setOtmId(""); setBankAccNo(""); setStartDate("");
    setProjection(null); setSipResult(null);
    setError("");
    setStep(STEPS.LOGIN);
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="header">
        <h1>Kotak MF — SIP Investment Portal</h1>
        <p>Start a real Systematic Investment Plan with your Kotak MF account.</p>

        {/* Step indicator */}
        <div className="steps">
          {["Login", "Verify OTP", "SIP Details", "Confirmed"].map((label, i) => {
            const stepKeys = [STEPS.LOGIN, STEPS.OTP, STEPS.SIP, STEPS.CONFIRM];
            const active = step === stepKeys[i];
            const done = stepKeys.indexOf(step) > i;
            return (
              <div key={label} className={`step-dot ${active ? "active" : ""} ${done ? "done" : ""}`}>
                <span>{done ? "✓" : i + 1}</span>
                <label>{label}</label>
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="agent-error">
          {error}
          <button className="close-btn" onClick={clearError}>×</button>
        </div>
      )}

      {/* ── STEP 1: LOGIN ── */}
      {step === STEPS.LOGIN && (
        <div className="form-box">
          <h2>Investor Login</h2>
          <p className="form-hint">Enter your Kotak MF registered details. An OTP will be sent to your mobile.</p>
          <form onSubmit={handleLogin}>
            <div className="form-grid">
              <div className="form-field">
                <label>PAN Number</label>
                <input
                  type="text"
                  placeholder="e.g. ABCDE1234F"
                  value={pan}
                  onChange={e => setPan(e.target.value.toUpperCase())}
                  maxLength={10}
                  required
                />
              </div>

              <div className="form-field">
                <label>Mobile Number</label>
                <input
                  type="tel"
                  placeholder="e.g. 9876543210"
                  value={mobile}
                  onChange={e => setMobile(e.target.value.replace(/\D/g, ""))}
                  maxLength={10}
                  required
                />
              </div>

              <div className="form-field full-width">
                <label>Registered Email</label>
                <input
                  type="email"
                  placeholder="e.g. name@email.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="submit-row">
              <button type="submit" className="btn-submit" disabled={loading}>
                {loading ? "Sending OTP..." : "Send OTP →"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── STEP 2: OTP ── */}
      {step === STEPS.OTP && (
        <div className="form-box">
          <h2>Verify OTP</h2>
          <p className="form-hint">
            {investorName && <strong>{investorName} — </strong>}
            Enter the 6-digit OTP sent to +91{mobile}.
          </p>
          <form onSubmit={handleOtp}>
            <div className="form-grid">
              <div className="form-field full-width">
                <label>OTP</label>
                <input
                  type="text"
                  placeholder="Enter 6-digit OTP"
                  value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, ""))}
                  maxLength={6}
                  autoFocus
                  required
                />
              </div>
            </div>
            <div className="submit-row">
              <button type="button" className="btn-reset" onClick={() => setStep(STEPS.LOGIN)}>
                ← Back
              </button>
              <button type="submit" className="btn-submit" disabled={loading || otp.length < 6}>
                {loading ? "Verifying..." : "Verify & Continue →"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── STEP 3: SIP FORM ── */}
      {step === STEPS.SIP && (
        <div className="form-box">
          <h2>New SIP</h2>
          <p className="form-hint">Fill in your SIP details. Contact your Kotak relationship manager for folio, scheme code, and OTM ID.</p>
          <form onSubmit={handleSip}>
            <div className="form-grid">

              <div className="form-field">
                <label>Folio Number</label>
                <input type="text" placeholder="e.g. 15461772" value={folioNo}
                  onChange={e => setFolioNo(e.target.value)} required />
              </div>

              <div className="form-field">
                <label>Scheme Code</label>
                <input type="text" placeholder="e.g. KF001" value={schemeCd}
                  onChange={e => setSchemeCd(e.target.value)} required />
              </div>

              <div className="form-field full-width">
                <label>Scheme / Fund Name (optional)</label>
                <input type="text" placeholder="e.g. Kotak Flexi Cap Fund" value={schemeName}
                  onChange={e => setSchemeName(e.target.value)} />
              </div>

              <div className="form-field">
                <label>Monthly Amount (₹)</label>
                <input type="number" placeholder="e.g. 5000" value={amount}
                  onChange={e => setAmount(e.target.value)}
                  onBlur={calculateProjection} required />
              </div>

              <div className="form-field">
                <label>Frequency</label>
                <select value={frequency} onChange={e => { setFrequency(e.target.value); setProjection(null); }}>
                  <option value="MONTHLY">Monthly</option>
                  <option value="WEEKLY">Weekly</option>
                  <option value="QUARTERLY">Quarterly</option>
                </select>
              </div>

              <div className="form-field">
                <label>Duration (months)</label>
                <input type="number" placeholder="e.g. 36" value={durationMonths}
                  onChange={e => setDuration(e.target.value)}
                  onBlur={calculateProjection} required />
              </div>

              <div className="form-field">
                <label>Start Date (optional)</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
              </div>

              <div className="form-field">
                <label>OTM / Mandate ID</label>
                <input type="text" placeholder="Bank mandate ID" value={otmId}
                  onChange={e => setOtmId(e.target.value)} required />
              </div>

              <div className="form-field full-width">
                <label>Bank Account Number</label>
                <input type="text" placeholder="Linked bank account number" value={bankAccNo}
                  onChange={e => setBankAccNo(e.target.value)} required />
              </div>
            </div>

            {/* SIP projection card */}
            {projection && (
              <div className="projection-card">
                <h3>SIP Projection (@ 12% p.a.)</h3>
                <div className="projection-grid">
                  <div><span>Total Invested</span><strong>₹{projection.total_invested.toLocaleString("en-IN")}</strong></div>
                  <div><span>Est. Returns</span><strong>₹{projection.estimated_returns.toLocaleString("en-IN")}</strong></div>
                  <div><span>Maturity Value</span><strong>₹{projection.maturity_amount.toLocaleString("en-IN")}</strong></div>
                </div>
              </div>
            )}

            <div className="submit-row">
              <button type="button" className="btn-reset" onClick={handleReset}>Cancel</button>
              <button type="submit" className="btn-submit" disabled={loading}>
                {loading ? "Creating SIP..." : "Confirm & Start SIP →"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── STEP 4: CONFIRMATION ── */}
      {step === STEPS.CONFIRM && sipResult && (
        <div className="form-box">
          <div className="success-banner">
            <h2>SIP Created Successfully!</h2>
            <p>{sipResult?.msgTable?.[0]?.as_results || "Your SIP has been registered with Kotak MF."}</p>
          </div>

          <div className="form-grid" style={{ marginTop: "1.5rem" }}>
            <div className="form-field"><label>Folio</label><input readOnly value={folioNo} /></div>
            <div className="form-field"><label>Scheme Code</label><input readOnly value={schemeCd} /></div>
            {schemeName && <div className="form-field full-width"><label>Fund</label><input readOnly value={schemeName} /></div>}
            <div className="form-field"><label>Amount</label><input readOnly value={`₹${Number(amount).toLocaleString("en-IN")} ${frequency}`} /></div>
            <div className="form-field"><label>Duration</label><input readOnly value={`${durationMonths} months`} /></div>
          </div>

          <div className="submit-row">
            <button className="btn-submit" onClick={handleReset}>Start Another SIP</button>
          </div>
        </div>
      )}
    </>
  );
}
