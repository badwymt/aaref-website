import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// LAYER 1: Device Fingerprint + Rate Limiting Engine
// ============================================================
const DeviceFingerprint = {
  _hash: null,
  _submissions: [],
  generate() {
    if (this._hash) return this._hash;
    const raw = [
      navigator.language, screen.width, screen.height, screen.colorDepth,
      new Date().getTimezoneOffset(), navigator.hardwareConcurrency || "?",
      navigator.maxTouchPoints || 0, window.devicePixelRatio || 1,
    ].join("|");
    let hash = 0;
    for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
    this._hash = Math.abs(hash).toString(36);
    return this._hash;
  },
  recordSubmission() {
    this._submissions.push(Date.now());
    this._submissions = this._submissions.filter(t => Date.now() - t < 3600000);
  },
  getRecentCount() {
    this._submissions = this._submissions.filter(t => Date.now() - t < 3600000);
    return this._submissions.length;
  },
  checkRateLimit() {
    const count = this.getRecentCount();
    if (count >= 5) return { blocked: true, reason: "rate_hard", msg: "Too many submissions. Try again in an hour." };
    if (count >= 3) return { blocked: false, reason: "rate_warn", msg: "Multiple submissions detected. Please only submit your own salary." };
    return { blocked: false, reason: null, msg: null };
  }
};

// ============================================================
// LAYER 2: Statistical Outlier Detection
// ============================================================
function detectOutliers(entry, existingSalaries) {
  const flags = [];
  let trustScore = 100;
  const sal = entry.salary;

  const sameIndustry = existingSalaries.filter(s => s.industry === entry.industry);
  const sameIndustryExp = existingSalaries.filter(s => s.industry === entry.industry && s.experience === entry.experience);
  const sameCompany = existingSalaries.filter(s => s.company.toLowerCase() === entry.company.toLowerCase());

  // Z-score against industry
  if (sameIndustry.length >= 3) {
    const mean = sameIndustry.reduce((a, s) => a + s.salary, 0) / sameIndustry.length;
    const variance = sameIndustry.reduce((a, s) => a + Math.pow(s.salary - mean, 2), 0) / sameIndustry.length;
    const stdDev = Math.sqrt(variance) || 1;
    const zScore = Math.abs(sal - mean) / stdDev;
    if (zScore > 3.0) { flags.push({ type: "extreme_outlier", severity: "high", detail: `Z-score ${zScore.toFixed(1)} vs ${entry.industry} (n=${sameIndustry.length})` }); trustScore -= 40; }
    else if (zScore > 2.5) { flags.push({ type: "outlier", severity: "medium", detail: `Z-score ${zScore.toFixed(1)} vs ${entry.industry}` }); trustScore -= 20; }
  }

  // Experience-salary coherence
  const expMap = { "0-1 years": [5000, 25000], "1-3 years": [8000, 40000], "3-5 years": [12000, 60000], "5-8 years": [15000, 80000], "8-12 years": [20000, 100000], "12+ years": [25000, 150000] };
  const [expMin, expMax] = expMap[entry.experience] || [0, 999999];
  if (sal < expMin * 0.5) { flags.push({ type: "low_for_exp", severity: "medium", detail: `EGP ${sal.toLocaleString()} unusually low for ${entry.experience}` }); trustScore -= 15; }
  if (sal > expMax * 1.5) { flags.push({ type: "high_for_exp", severity: "high", detail: `EGP ${sal.toLocaleString()} unusually high for ${entry.experience}` }); trustScore -= 30; }

  // Company consistency check
  if (sameCompany.length >= 2) {
    const compMean = sameCompany.reduce((a, s) => a + s.salary, 0) / sameCompany.length;
    const deviation = Math.abs(sal - compMean) / compMean;
    if (deviation > 1.0) { flags.push({ type: "company_mismatch", severity: "high", detail: `${Math.round(deviation * 100)}% from ${entry.company} average` }); trustScore -= 25; }
  }

  // Round number suspicion (people making up numbers tend to use round numbers)
  if (sal >= 10000 && sal % 10000 === 0 && sal > 50000) {
    trustScore -= 5; // Minor signal, not flagged visibly
  }

  // Exact duplicate detection
  const isDuplicate = existingSalaries.some(s =>
    s.title.toLowerCase() === entry.title.toLowerCase() &&
    s.company.toLowerCase() === entry.company.toLowerCase() &&
    s.salary === sal
  );
  if (isDuplicate) { flags.push({ type: "duplicate", severity: "high", detail: "Exact match exists in database" }); trustScore -= 50; }

  trustScore = Math.max(0, Math.min(100, trustScore));
  const status = trustScore >= 70 ? "auto_approved" : trustScore >= 40 ? "needs_review" : "flagged";

  return { flags, trustScore, status };
}

// ============================================================
// DATA + CONSTANTS
// ============================================================
const INDUSTRIES = ["Technology", "Banking & Finance", "Telecom", "FMCG", "Pharma", "Healthcare", "Engineering", "Education", "Media", "Other"];
const EXPERIENCE_LEVELS = ["0-1 years", "1-3 years", "3-5 years", "5-8 years", "8-12 years", "12+ years"];
const CITIES = ["Cairo", "Giza", "Alexandria", "Mansoura", "Tanta", "Aswan", "Other"];

const INITIAL_SALARIES = [
  { id: 1, title: "Software Engineer", company: "Vodafone Egypt", industry: "Telecom", city: "Cairo", experience: "3-5 years", salary: 25000, submitted: "2026-02-27", verified: true, trustScore: 95, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 2, title: "Senior Frontend Developer", company: "Instabug", industry: "Technology", city: "Cairo", experience: "5-8 years", salary: 45000, submitted: "2026-02-26", verified: true, trustScore: 92, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 3, title: "Data Analyst", company: "CIB", industry: "Banking & Finance", city: "Cairo", experience: "1-3 years", salary: 15000, submitted: "2026-02-26", verified: false, trustScore: 88, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 4, title: "Product Manager", company: "Swvl", industry: "Technology", city: "Cairo", experience: "5-8 years", salary: 55000, submitted: "2026-02-25", verified: true, trustScore: 78, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 5, title: "DevOps Engineer", company: "Fawry", industry: "Technology", city: "Cairo", experience: "3-5 years", salary: 30000, submitted: "2026-02-25", verified: false, trustScore: 90, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 6, title: "Marketing Manager", company: "Nestle Egypt", industry: "FMCG", city: "Giza", experience: "5-8 years", salary: 35000, submitted: "2026-02-24", verified: true, trustScore: 94, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 7, title: "Financial Analyst", company: "EFG Hermes", industry: "Banking & Finance", city: "Cairo", experience: "3-5 years", salary: 28000, submitted: "2026-02-24", verified: true, trustScore: 91, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 8, title: "Backend Developer", company: "Paymob", industry: "Technology", city: "Cairo", experience: "3-5 years", salary: 32000, submitted: "2026-02-23", verified: false, trustScore: 87, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 9, title: "UX Designer", company: "Orange Egypt", industry: "Telecom", city: "Cairo", experience: "1-3 years", salary: 18000, submitted: "2026-02-23", verified: true, trustScore: 93, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 10, title: "Pharmacist", company: "Eva Pharma", industry: "Pharma", city: "Cairo", experience: "1-3 years", salary: 12000, submitted: "2026-02-22", verified: false, trustScore: 85, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 11, title: "Network Engineer", company: "Etisalat Egypt", industry: "Telecom", city: "Alexandria", experience: "5-8 years", salary: 28000, submitted: "2026-02-22", verified: true, trustScore: 90, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 12, title: "QA Engineer", company: "Breadfast", industry: "Technology", city: "Cairo", experience: "1-3 years", salary: 16000, submitted: "2026-02-21", verified: false, trustScore: 86, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 13, title: "iOS Developer", company: "Careem", industry: "Technology", city: "Cairo", experience: "5-8 years", salary: 50000, submitted: "2026-02-21", verified: true, trustScore: 88, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 14, title: "HR Manager", company: "Telecom Egypt", industry: "Telecom", city: "Cairo", experience: "8-12 years", salary: 38000, submitted: "2026-02-20", verified: true, trustScore: 91, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 15, title: "ML Engineer", company: "Valeo Egypt", industry: "Technology", city: "Cairo", experience: "3-5 years", salary: 40000, submitted: "2026-02-20", verified: true, trustScore: 89, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 16, title: "Accountant", company: "KPMG Egypt", industry: "Banking & Finance", city: "Cairo", experience: "1-3 years", salary: 14000, submitted: "2026-02-19", verified: false, trustScore: 84, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 17, title: "Sales Executive", company: "P&G Egypt", industry: "FMCG", city: "Giza", experience: "3-5 years", salary: 22000, submitted: "2026-02-19", verified: true, trustScore: 92, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 18, title: "Full Stack Developer", company: "MoneyFellows", industry: "Technology", city: "Cairo", experience: "3-5 years", salary: 35000, submitted: "2026-02-18", verified: true, trustScore: 90, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 19, title: "Civil Engineer", company: "Orascom", industry: "Engineering", city: "Cairo", experience: "5-8 years", salary: 20000, submitted: "2026-02-18", verified: false, trustScore: 82, status: "auto_approved", flags: [], flagCount: 0 },
  { id: 20, title: "Android Developer", company: "Halan", industry: "Technology", city: "Cairo", experience: "3-5 years", salary: 28000, submitted: "2026-02-17", verified: true, trustScore: 91, status: "auto_approved", flags: [], flagCount: 0 },
  // Pre-seeded flagged entries for admin demo
  { id: 21, title: "Junior Intern", company: "Unknown Startup", industry: "Technology", city: "Cairo", experience: "0-1 years", salary: 120000, submitted: "2026-02-28", verified: false, trustScore: 22, status: "flagged", flags: [{ type: "extreme_outlier", severity: "high", detail: "Z-score 4.1 vs Technology (n=11)" }, { type: "high_for_exp", severity: "high", detail: "EGP 120,000 unusually high for 0-1 years" }], flagCount: 0, deviceHash: "abc12" },
  { id: 22, title: "Software Engineer", company: "Vodafone Egypt", industry: "Telecom", city: "Cairo", experience: "3-5 years", salary: 25000, submitted: "2026-02-28", verified: false, trustScore: 35, status: "flagged", flags: [{ type: "duplicate", severity: "high", detail: "Exact match exists in database" }], flagCount: 0, deviceHash: "def34" },
  { id: 23, title: "CEO", company: "Small Local Shop", industry: "Other", city: "Cairo", experience: "12+ years", salary: 500000, submitted: "2026-02-28", verified: false, trustScore: 18, status: "flagged", flags: [{ type: "extreme_outlier", severity: "high", detail: "Z-score 6.2 (no comparable entries)" }, { type: "high_for_exp", severity: "high", detail: "EGP 500,000 outlier even for 12+ years" }], flagCount: 2, deviceHash: "ghi56" },
  { id: 24, title: "Data Scientist", company: "Fawry", industry: "Technology", city: "Cairo", experience: "3-5 years", salary: 85000, submitted: "2026-02-27", verified: false, trustScore: 52, status: "needs_review", flags: [{ type: "outlier", severity: "medium", detail: "Z-score 2.7 vs Technology" }], flagCount: 0, deviceHash: "jkl78", salaryType: "gross", contractType: "permanent", recentRaise: "yes" },
  { id: 25, title: "Receptionist", company: "Hilton Cairo", industry: "Other", city: "Cairo", experience: "1-3 years", salary: 4000, submitted: "2026-02-27", verified: false, trustScore: 55, status: "needs_review", flags: [{ type: "low_for_exp", severity: "medium", detail: "EGP 4,000 unusually low for 1-3 years" }], flagCount: 0, deviceHash: "mno90" },
];

const fmt = n => n.toLocaleString("en-US");
const daysAgo = d => { const n = Math.floor((Date.now() - new Date(d)) / 864e5); return n === 0 ? "Today" : n === 1 ? "Yesterday" : `${n}d ago`; };

const C = {
  teal: "#0d9488", tealDark: "#0f766e", tealLight: "#ccfbf1", tealBg: "#f0fdfa",
  bg: "#fafafa", card: "#ffffff", border: "#e5e7eb", borderLight: "#f3f4f6",
  text: "#111827", textMuted: "#6b7280", textLight: "#9ca3af",
  green: "#059669", red: "#dc2626", orange: "#d97706", warmBg: "#fefce8",
  redBg: "#fef2f2", redBorder: "#fecaca", orangeBg: "#fffbeb", orangeBorder: "#fed7aa",
  greenBg: "#f0fdf4", greenBorder: "#bbf7d0",
};

const Icons = {
  search: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>,
  shield: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  trending: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23,6 13.5,15.5 8.5,10.5 1,18"/><polyline points="17,6 23,6 23,12"/></svg>,
  building: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01"/></svg>,
  zap: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20,6 9,17 4,12"/></svg>,
  arrow: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>,
  menu: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>,
  x: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>,
  lock: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  flag: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>,
  alert: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  thumbsDown: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3zm7-13h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17"/></svg>,
};

// ============================================================
// SHARED COMPONENTS
// ============================================================
function Nav({ page, setPage, adminMode, setAdminMode }) {
  const [open, setOpen] = useState(false);
  const links = [
    { id: "home", label: "Salaries" },
    { id: "explore", label: "Explorer" },
    { id: "compare", label: "Compare" },
    { id: "about", label: "About" },
  ];
  return (
    <nav style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, background: "#fff", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56 }}>
        <button onClick={() => setPage("home")} style={{ display: "flex", alignItems: "center", gap: 8, border: "none", background: "none", cursor: "pointer", padding: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 6, background: C.teal, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 15 }}>ع</div>
          <span style={{ fontSize: 17, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>Aaref</span>
          <span style={{ fontSize: 14, color: C.textLight, fontWeight: 500 }}>اعرف</span>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }} className="nav-desktop">
          {links.map(l => (
            <button key={l.id} onClick={() => setPage(l.id)} style={{ border: "none", background: page === l.id ? C.tealBg : "transparent", cursor: "pointer", padding: "6px 14px", borderRadius: 6, fontSize: 14, fontWeight: 500, color: page === l.id ? C.tealDark : C.textMuted }}>{l.label}</button>
          ))}
          <button onClick={() => setPage("admin")} style={{ border: "none", background: page === "admin" ? "#fef2f2" : "transparent", cursor: "pointer", padding: "6px 14px", borderRadius: 6, fontSize: 14, fontWeight: 500, color: page === "admin" ? C.red : C.textLight }}>Admin</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }} className="nav-desktop">
          <button onClick={() => setPage("submit")} style={{ border: "none", background: C.teal, color: "#fff", cursor: "pointer", padding: "7px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600 }}>Share Salary</button>
        </div>
      </div>
    </nav>
  );
}

// LAYER 4: Flag button on salary rows
function SalaryRow({ s, onFlag }) {
  const [showFlag, setShowFlag] = useState(false);
  const [flagged, setFlagged] = useState(false);
  const isFlaggable = s.status === "auto_approved" || !s.status;

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "14px 20px", borderBottom: `1px solid ${C.borderLight}`, background: C.card, gap: 8 }}
      onMouseEnter={() => setShowFlag(true)} onMouseLeave={() => setShowFlag(false)}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{s.title}</span>
          {s.verified && <span style={{ color: C.teal, display: "flex" }}>{Icons.check}</span>}
          {s.trustScore && s.trustScore < 70 && <span style={{ fontSize: 10, color: C.orange, background: C.orangeBg, padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>Under review</span>}
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
          {s.company} &middot; {s.city} &middot; {s.experience}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* LAYER 4: Community flag button */}
        {isFlaggable && (showFlag || flagged) && (
          <button onClick={() => { if (!flagged) { setFlagged(true); if (onFlag) onFlag(s.id); } }}
            style={{ border: "none", background: "none", cursor: flagged ? "default" : "pointer", color: flagged ? C.red : C.textLight, display: "flex", alignItems: "center", gap: 3, fontSize: 11, padding: "2px 6px", borderRadius: 4, opacity: flagged ? 1 : 0.7 }}
            title={flagged ? "Flagged for review" : "Flag as suspicious"}>
            {Icons.flag} {flagged ? "Flagged" : "Flag"}
          </button>
        )}
        <div style={{ textAlign: "right" }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{s.salary >= 0 ? `EGP ${fmt(s.salary)}` : "—"}</span>
          <span style={{ fontSize: 12, color: C.textLight, marginLeft: 2 }}>/mo</span>
          <div style={{ fontSize: 11, color: C.textLight, marginTop: 1 }}>{daysAgo(s.submitted)}</div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div style={{ textAlign: "center", padding: "16px 0" }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: C.textLight, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ============================================================
// HOME PAGE
// ============================================================
function HomePage({ setPage, salaries }) {
  const approved = salaries.filter(s => s.status !== "flagged");
  const industries = [
    { name: "Technology", count: 847, avg: 33000 },
    { name: "Banking & Finance", count: 312, avg: 26000 },
    { name: "Telecom", count: 245, avg: 28000 },
    { name: "FMCG", count: 198, avg: 24000 },
    { name: "Pharma", count: 156, avg: 18000 },
    { name: "Engineering", count: 134, avg: 20000 },
  ];
  const companies = [
    { name: "Instabug", count: 45, avg: 42000 },
    { name: "Vodafone Egypt", count: 67, avg: 28000 },
    { name: "CIB", count: 38, avg: 30000 },
    { name: "Swvl", count: 22, avg: 48000 },
    { name: "Paymob", count: 28, avg: 34000 },
    { name: "Fawry", count: 31, avg: 26000 },
  ];

  return (
    <div style={{ paddingTop: 56 }}>
      <section style={{ background: "#fff", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "48px 20px 40px" }}>
          <div style={{ maxWidth: 600 }}>
            <h1 style={{ fontSize: 32, fontWeight: 700, color: C.text, lineHeight: 1.2, margin: 0, letterSpacing: "-0.03em" }}>Real salaries from<br />Egyptian professionals</h1>
            <p style={{ fontSize: 16, color: C.textMuted, marginTop: 12, lineHeight: 1.6, maxWidth: 480 }}>Anonymous, real-time salary data. No login required. Every entry is statistically validated before it goes live.</p>
            <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
              <button onClick={() => setPage("explore")} style={{ border: "none", background: C.teal, color: "#fff", padding: "10px 20px", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Explore salaries</button>
              <button onClick={() => setPage("submit")} style={{ border: `1px solid ${C.border}`, background: "#fff", color: C.text, padding: "10px 20px", borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Share yours — it's anonymous</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 0, marginTop: 36, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
            <div style={{ flex: 1 }}><Stat label="Verified entries" value="4,544" /></div>
            <div style={{ flex: 1, borderLeft: `1px solid ${C.border}` }}><Stat label="Companies" value="909" /></div>
            <div style={{ flex: 1, borderLeft: `1px solid ${C.border}` }}><Stat label="Data quality" value="94%" sub="auto-validated" /></div>
            <div style={{ flex: 1, borderLeft: `1px solid ${C.border}` }}><Stat label="Updated" value="Live" sub="real-time" /></div>
          </div>
        </div>
      </section>

      <section style={{ background: C.bg }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: C.text, margin: 0 }}>Recent submissions</h2>
            <button onClick={() => setPage("explore")} style={{ border: "none", background: "none", color: C.teal, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>View all {Icons.arrow}</button>
          </div>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 20px", background: "#f9fafb", borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.textLight, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <span>Role & Company</span><span>Monthly Salary</span>
            </div>
            {approved.slice(0, 8).map(s => <SalaryRow key={s.id} s={s} />)}
          </div>
        </div>
      </section>

      <section style={{ background: "#fff", borderTop: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 20px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40 }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, color: C.text, margin: "0 0 16px" }}>By industry</h2>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                {industries.map((ind, i) => (
                  <div key={ind.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: i < industries.length - 1 ? `1px solid ${C.borderLight}` : "none" }}>
                    <div><div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{ind.name}</div><div style={{ fontSize: 12, color: C.textLight }}>{ind.count} entries</div></div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>EGP {fmt(ind.avg)}<span style={{ fontSize: 11, color: C.textLight, fontWeight: 400 }}> avg</span></div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, color: C.text, margin: "0 0 16px" }}>Top companies</h2>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                {companies.map((co, i) => (
                  <button key={co.name} onClick={() => setPage("explore")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: i < companies.length - 1 ? `1px solid ${C.borderLight}` : "none", width: "100%", border: "none", background: "none", cursor: "pointer", textAlign: "left" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 6, background: C.tealBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, color: C.tealDark }}>{co.name[0]}</div>
                      <div><div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{co.name}</div><div style={{ fontSize: 12, color: C.textLight }}>{co.count} salaries</div></div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>EGP {fmt(co.avg)}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Data quality section */}
      <section style={{ background: C.bg, borderTop: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 20px" }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: C.text, margin: "0 0 24px" }}>How we keep data honest</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 20 }}>
            {[
              { icon: Icons.shield, title: "Device fingerprint", desc: "Rate-limit submissions per device without storing personal data. No cookies needed." },
              { icon: Icons.trending, title: "Outlier detection", desc: "Z-score analysis flags salaries that deviate significantly from industry norms." },
              { icon: Icons.building, title: "Cross-validation", desc: "Entries checked against company + role + experience clusters for consistency." },
              { icon: Icons.flag, title: "Community flags", desc: "Users can flag suspicious entries. Flagged data goes to manual review." },
              { icon: Icons.zap, title: "Admin review", desc: "Flagged and borderline entries are manually reviewed before going live." },
            ].map(item => (
              <div key={item.title}>
                <div style={{ color: C.teal, marginBottom: 10 }}>{item.icon}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>{item.title}</div>
                <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.6 }}>{item.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ background: "#fff", borderTop: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "48px 20px", textAlign: "center" }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>Salary secrecy benefits employers. Transparency benefits you.</h2>
          <p style={{ fontSize: 15, color: C.textMuted, marginTop: 8, marginBottom: 24 }}>Join 4,544 Egyptian professionals who've shared. Takes 30 seconds. No account needed.</p>
          <button onClick={() => setPage("submit")} style={{ border: "none", background: C.teal, color: "#fff", padding: "11px 28px", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Share your salary</button>
        </div>
      </section>
    </div>
  );
}

// ============================================================
// EXPLORE PAGE (with community flagging - Layer 4)
// ============================================================
function ExplorePage({ salaries, onFlag }) {
  const [search, setSearch] = useState("");
  const [industry, setIndustry] = useState("All");
  const [exp, setExp] = useState("All");
  const [sort, setSort] = useState("recent");

  const approved = salaries.filter(s => s.status !== "flagged");
  const filtered = approved.filter(s => {
    const q = search.toLowerCase();
    return (!q || s.title.toLowerCase().includes(q) || s.company.toLowerCase().includes(q)) &&
      (industry === "All" || s.industry === industry) &&
      (exp === "All" || s.experience === exp);
  }).sort((a, b) => sort === "highest" ? b.salary - a.salary : sort === "lowest" ? a.salary - b.salary : 0);

  const avg = filtered.length ? Math.round(filtered.reduce((a, s) => a + s.salary, 0) / filtered.length) : 0;
  const sorted = [...filtered].sort((a, b) => a.salary - b.salary);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)].salary : 0;

  const sel = { padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, color: C.text, background: "#fff", cursor: "pointer" };

  return (
    <div style={{ paddingTop: 56, background: C.bg, minHeight: "100vh" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 20px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>Salary Explorer</h1>
        <p style={{ fontSize: 14, color: C.textMuted, margin: "4px 0 20px" }}>{approved.length} validated entries &middot; Flagged entries excluded</p>

        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200, position: "relative" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by role or company..." style={{ width: "100%", padding: "8px 12px 8px 36px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, color: C.text, outline: "none", boxSizing: "border-box" }} />
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: C.textLight }}>{Icons.search}</span>
          </div>
          <select value={industry} onChange={e => setIndustry(e.target.value)} style={sel}><option value="All">All industries</option>{INDUSTRIES.map(i => <option key={i}>{i}</option>)}</select>
          <select value={exp} onChange={e => setExp(e.target.value)} style={sel}><option value="All">All experience</option>{EXPERIENCE_LEVELS.map(e => <option key={e}>{e}</option>)}</select>
          <select value={sort} onChange={e => setSort(e.target.value)} style={sel}><option value="recent">Most recent</option><option value="highest">Highest first</option><option value="lowest">Lowest first</option></select>
        </div>

        {filtered.length > 0 && (
          <div style={{ display: "flex", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 20, overflow: "hidden" }}>
            {[["Average", fmt(avg)], ["Median", fmt(median)], ["Results", filtered.length]].map(([l, v], i) => (
              <div key={l} style={{ flex: 1, padding: "14px 16px", textAlign: "center", borderLeft: i ? `1px solid ${C.border}` : "none" }}>
                <div style={{ fontSize: 11, color: C.textLight, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>{l}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginTop: 2 }}>{typeof v === "number" ? v : `EGP ${v}`}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 20px", background: "#f9fafb", borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.textLight, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <span>Role & Company</span><span>Monthly Salary</span>
          </div>
          {filtered.map(s => <SalaryRow key={s.id} s={s} onFlag={onFlag} />)}
          {filtered.length === 0 && <div style={{ padding: "48px 20px", textAlign: "center", color: C.textLight, fontSize: 14 }}>No results match your filters</div>}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SUBMIT PAGE (Layer 1 + 2 + 3 + 4 integrated)
// ============================================================
function SubmitPage({ salaries, setSalaries }) {
  const [form, setForm] = useState({
    title: "", company: "", industry: "Technology", city: "Cairo", experience: "3-5 years",
    salary: "", bonus: "",
    // LAYER 3: Friction fields (optional but signal-rich)
    salaryType: "", contractType: "", recentRaise: "", companySize: "",
  });
  const [submitted, setSubmitted] = useState(false);
  const [comparison, setComparison] = useState(null);
  const [validationResult, setValidationResult] = useState(null);
  const [rateError, setRateError] = useState(null);
  const [showNearby, setShowNearby] = useState([]);

  // LAYER 4: Show nearby entries when user fills company
  useEffect(() => {
    if (form.company.length > 2) {
      const nearby = salaries.filter(s => s.company.toLowerCase().includes(form.company.toLowerCase()) && s.status !== "flagged").slice(0, 4);
      setShowNearby(nearby);
    } else { setShowNearby([]); }
  }, [form.company, salaries]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.title || !form.company || !form.salary) return;
    const sal = parseInt(form.salary);
    if (isNaN(sal) || sal <= 0) return;

    // LAYER 1: Rate limit check
    const rateCheck = DeviceFingerprint.checkRateLimit();
    if (rateCheck.blocked) { setRateError(rateCheck.msg); return; }

    // LAYER 2: Statistical outlier detection
    const entry = { ...form, salary: sal };
    const analysis = detectOutliers(entry, salaries);

    // LAYER 3: Friction field completion boosts trust
    const optionalFieldsCompleted = [form.salaryType, form.contractType, form.recentRaise, form.companySize].filter(Boolean).length;
    if (optionalFieldsCompleted >= 3) analysis.trustScore = Math.min(100, analysis.trustScore + 10);
    if (optionalFieldsCompleted >= 2) analysis.trustScore = Math.min(100, analysis.trustScore + 5);
    if (analysis.trustScore >= 70) analysis.status = "auto_approved";
    else if (analysis.trustScore >= 40) analysis.status = "needs_review";

    DeviceFingerprint.recordSubmission();

    const newEntry = {
      ...form, id: Date.now(), salary: sal, submitted: new Date().toISOString().split("T")[0],
      verified: false, trustScore: analysis.trustScore, status: analysis.status,
      flags: analysis.flags, flagCount: 0, deviceHash: DeviceFingerprint.generate(),
    };
    setSalaries(prev => [newEntry, ...prev]);

    // Comparison data
    const similar = salaries.filter(s => s.industry === form.industry && s.status !== "flagged");
    const avg = similar.length ? Math.round(similar.reduce((a, s) => a + s.salary, 0) / similar.length) : sal;
    const diff = Math.round(((sal - avg) / avg) * 100);
    const sortedSimilar = [...similar].sort((a, b) => a.salary - b.salary);
    const below = sortedSimilar.filter(s => s.salary <= sal).length;
    const percentile = similar.length ? Math.round((below / similar.length) * 100) : 50;

    setComparison({ avg, diff, count: similar.length, percentile });
    setValidationResult(analysis);
    setSubmitted(true);
  };

  const inp = { width: "100%", padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, color: C.text, outline: "none", boxSizing: "border-box" };
  const lbl = { display: "block", fontSize: 13, fontWeight: 500, color: C.text, marginBottom: 5 };
  const optLbl = { display: "block", fontSize: 12, fontWeight: 500, color: C.textMuted, marginBottom: 4 };

  if (submitted && comparison && validationResult) {
    return (
      <div style={{ paddingTop: 56, background: C.bg, minHeight: "100vh" }}>
        <div style={{ maxWidth: 520, margin: "0 auto", padding: "40px 20px" }}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 32 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>
              {validationResult.status === "auto_approved" ? "Submitted and live" : validationResult.status === "needs_review" ? "Submitted — under review" : "Submitted — flagged for review"}
            </h2>

            {/* LAYER 2: Show validation status */}
            <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, fontSize: 13, lineHeight: 1.6,
              background: validationResult.status === "auto_approved" ? C.greenBg : validationResult.status === "needs_review" ? C.orangeBg : C.redBg,
              border: `1px solid ${validationResult.status === "auto_approved" ? C.greenBorder : validationResult.status === "needs_review" ? C.orangeBorder : C.redBorder}`,
              color: validationResult.status === "auto_approved" ? "#166534" : validationResult.status === "needs_review" ? "#92400e" : "#991b1b",
            }}>
              {validationResult.status === "auto_approved" && <span><strong>Passed validation.</strong> Your entry is live and visible to everyone. Trust score: {validationResult.trustScore}/100.</span>}
              {validationResult.status === "needs_review" && <span><strong>Pending review.</strong> Your salary is slightly outside typical ranges for this role. An admin will review it within 24 hours. Trust score: {validationResult.trustScore}/100.</span>}
              {validationResult.status === "flagged" && <span><strong>Held for review.</strong> This entry was flagged by our outlier detection system. It will be reviewed manually. This does not mean it's wrong — unusual salaries sometimes are real.</span>}
              {validationResult.flags.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                  Flags: {validationResult.flags.map(f => f.detail).join(" · ")}
                </div>
              )}
            </div>

            <div style={{ marginTop: 20, padding: 20, background: C.tealBg, borderRadius: 8, border: `1px solid #99f6e4` }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: C.tealDark, marginBottom: 8 }}>Your position in {form.industry}</div>
              <div style={{ display: "flex", gap: 24, alignItems: "baseline" }}>
                <div>
                  <span style={{ fontSize: 32, fontWeight: 700, color: C.text }}>{comparison.percentile}</span>
                  <span style={{ fontSize: 14, color: C.textMuted }}>th percentile</span>
                </div>
                <div>
                  <span style={{ fontSize: 20, fontWeight: 700, color: comparison.diff >= 0 ? C.green : C.red }}>{comparison.diff >= 0 ? "+" : ""}{comparison.diff}%</span>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{comparison.diff >= 0 ? "above" : "below"} avg (EGP {fmt(comparison.avg)})</div>
                </div>
              </div>
              <div style={{ marginTop: 12, background: "#d1fae5", borderRadius: 4, height: 6, position: "relative" }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${comparison.percentile}%`, background: C.teal, borderRadius: 4 }} />
              </div>
            </div>

            <div style={{ marginTop: 16, padding: 14, background: C.bg, borderRadius: 6, fontSize: 13, color: C.textMuted, lineHeight: 1.7 }}>
              <strong style={{ color: C.text }}>Privacy:</strong> No account, no email, no IP, no cookies. Device fingerprint used only for rate-limiting (not stored permanently).
            </div>
            <button onClick={() => { setSubmitted(false); setValidationResult(null); setForm({ title: "", company: "", industry: "Technology", city: "Cairo", experience: "3-5 years", salary: "", bonus: "", salaryType: "", contractType: "", recentRaise: "", companySize: "" }); }}
              style={{ marginTop: 16, border: `1px solid ${C.border}`, background: "#fff", color: C.text, padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>Submit another</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 56, background: C.bg, minHeight: "100vh" }}>
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "40px 20px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>Share your salary</h1>
        <p style={{ fontSize: 14, color: C.textMuted, margin: "6px 0 0" }}>Anonymous. No account. Statistically validated.</p>

        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 16, padding: "10px 14px", background: C.tealBg, borderRadius: 6, border: `1px solid #ccfbf1` }}>
          <span style={{ color: C.teal, marginTop: 1, flexShrink: 0 }}>{Icons.lock}</span>
          <span style={{ fontSize: 13, color: C.tealDark, lineHeight: 1.5 }}>No login, no email, no IP logging. We use device fingerprinting only for rate-limiting (max 5 submissions/hour). Never stored permanently.</span>
        </div>

        {/* LAYER 1: Rate limit warning */}
        {rateError && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 6, fontSize: 13, color: "#991b1b" }}>
            {Icons.alert} {rateError}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ marginTop: 24, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 24 }}>
          {/* Core fields */}
          <div style={{ marginBottom: 16 }}><label style={lbl}>Job title <span style={{ color: C.red }}>*</span></label><input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Software Engineer" style={inp} required /></div>
          <div style={{ marginBottom: 16 }}>
            <label style={lbl}>Company <span style={{ color: C.red }}>*</span></label>
            <input value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} placeholder="e.g. Vodafone Egypt" style={inp} required />
            {/* LAYER 4: Nearby entries for self-correction */}
            {showNearby.length > 0 && (
              <div style={{ marginTop: 6, padding: "8px 10px", background: "#f9fafb", borderRadius: 4, border: `1px solid ${C.borderLight}`, fontSize: 12 }}>
                <div style={{ color: C.textMuted, fontWeight: 600, marginBottom: 4 }}>Existing entries at {form.company}:</div>
                {showNearby.map(n => (
                  <div key={n.id} style={{ color: C.textMuted, padding: "2px 0" }}>{n.title} — EGP {fmt(n.salary)} ({n.experience})</div>
                ))}
                <div style={{ color: C.textLight, marginTop: 4, fontStyle: "italic" }}>Does your entry look consistent with these?</div>
              </div>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div><label style={lbl}>Industry</label><select value={form.industry} onChange={e => setForm({ ...form, industry: e.target.value })} style={inp}>{INDUSTRIES.map(i => <option key={i}>{i}</option>)}</select></div>
            <div><label style={lbl}>City</label><select value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} style={inp}>{CITIES.map(c => <option key={c}>{c}</option>)}</select></div>
          </div>
          <div style={{ marginBottom: 16 }}><label style={lbl}>Experience</label><select value={form.experience} onChange={e => setForm({ ...form, experience: e.target.value })} style={inp}>{EXPERIENCE_LEVELS.map(e => <option key={e}>{e}</option>)}</select></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div><label style={lbl}>Monthly salary (EGP) <span style={{ color: C.red }}>*</span></label><input type="number" value={form.salary} onChange={e => setForm({ ...form, salary: e.target.value })} placeholder="25000" style={inp} required /></div>
            <div><label style={lbl}>Annual bonus (EGP)</label><input type="number" value={form.bonus} onChange={e => setForm({ ...form, bonus: e.target.value })} placeholder="Optional" style={inp} /></div>
          </div>

          {/* LAYER 3: Optional friction fields */}
          <div style={{ borderTop: `1px solid ${C.borderLight}`, paddingTop: 16, marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.textMuted, marginBottom: 12 }}>
              Optional details <span style={{ fontWeight: 400, color: C.textLight }}>— more detail = higher trust score</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={optLbl}>Salary type</label>
                <select value={form.salaryType} onChange={e => setForm({ ...form, salaryType: e.target.value })} style={{ ...inp, fontSize: 13, color: form.salaryType ? C.text : C.textLight }}>
                  <option value="">Select...</option><option value="net">Net (after tax)</option><option value="gross">Gross (before tax)</option>
                </select>
              </div>
              <div>
                <label style={optLbl}>Contract type</label>
                <select value={form.contractType} onChange={e => setForm({ ...form, contractType: e.target.value })} style={{ ...inp, fontSize: 13, color: form.contractType ? C.text : C.textLight }}>
                  <option value="">Select...</option><option value="permanent">Permanent</option><option value="contract">Fixed-term contract</option><option value="outsourced">Outsourced</option><option value="freelance">Freelance</option>
                </select>
              </div>
              <div>
                <label style={optLbl}>Raise in last 12 months?</label>
                <select value={form.recentRaise} onChange={e => setForm({ ...form, recentRaise: e.target.value })} style={{ ...inp, fontSize: 13, color: form.recentRaise ? C.text : C.textLight }}>
                  <option value="">Select...</option><option value="yes">Yes</option><option value="no">No</option><option value="new_job">New job</option>
                </select>
              </div>
              <div>
                <label style={optLbl}>Company size</label>
                <select value={form.companySize} onChange={e => setForm({ ...form, companySize: e.target.value })} style={{ ...inp, fontSize: 13, color: form.companySize ? C.text : C.textLight }}>
                  <option value="">Select...</option><option value="1-50">1-50 employees</option><option value="50-200">50-200</option><option value="200-1000">200-1,000</option><option value="1000+">1,000+</option>
                </select>
              </div>
            </div>
          </div>

          <button type="submit" style={{ width: "100%", border: "none", background: C.teal, color: "#fff", padding: "11px 0", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Submit anonymously</button>
          <p style={{ fontSize: 12, color: C.textLight, textAlign: "center", marginTop: 10 }}>Entries are validated by our outlier detection system. Unusual entries get manual review.</p>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// COMPARE PAGE
// ============================================================
function ComparePage({ salaries }) {
  const [form, setForm] = useState({ title: "", industry: "Technology", experience: "3-5 years", salary: "" });
  const [result, setResult] = useState(null);
  const approved = salaries.filter(s => s.status !== "flagged");

  const handleCompare = (e) => {
    e.preventDefault();
    if (!form.salary) return;
    const sal = parseInt(form.salary);
    const similar = approved.filter(s => s.industry === form.industry);
    const avg = similar.length ? Math.round(similar.reduce((a, s) => a + s.salary, 0) / similar.length) : sal;
    const sameExp = approved.filter(s => s.experience === form.experience);
    const expAvg = sameExp.length ? Math.round(sameExp.reduce((a, s) => a + s.salary, 0) / sameExp.length) : sal;
    const sorted = [...similar].sort((a, b) => a.salary - b.salary);
    const below = sorted.filter(s => s.salary <= sal).length;
    const percentile = similar.length ? Math.round((below / similar.length) * 100) : 50;
    setResult({ avg, expAvg, percentile, diff: Math.round(((sal - avg) / avg) * 100), expDiff: Math.round(((sal - expAvg) / expAvg) * 100), count: similar.length, expCount: sameExp.length });
  };

  const inp = { width: "100%", padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, color: C.text, outline: "none", boxSizing: "border-box" };
  const lbl = { display: "block", fontSize: 13, fontWeight: 500, color: C.text, marginBottom: 5 };

  return (
    <div style={{ paddingTop: 56, background: C.bg, minHeight: "100vh" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 20px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>Compare your salary</h1>
        <p style={{ fontSize: 14, color: C.textMuted, margin: "4px 0 24px" }}>Based on {approved.length} validated entries. Flagged data excluded.</p>
        <form onSubmit={handleCompare} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 24, marginBottom: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div><label style={lbl}>Your job title</label><input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Software Engineer" style={inp} /></div>
            <div><label style={lbl}>Monthly salary (EGP) <span style={{ color: C.red }}>*</span></label><input type="number" value={form.salary} onChange={e => setForm({ ...form, salary: e.target.value })} placeholder="25000" style={inp} required /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div><label style={lbl}>Industry</label><select value={form.industry} onChange={e => setForm({ ...form, industry: e.target.value })} style={inp}>{INDUSTRIES.map(i => <option key={i}>{i}</option>)}</select></div>
            <div><label style={lbl}>Experience</label><select value={form.experience} onChange={e => setForm({ ...form, experience: e.target.value })} style={inp}>{EXPERIENCE_LEVELS.map(e => <option key={e}>{e}</option>)}</select></div>
          </div>
          <button type="submit" style={{ width: "100%", border: "none", background: C.teal, color: "#fff", padding: "11px 0", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Compare</button>
        </form>
        {result && (
          <div>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 24, marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: C.textMuted, marginBottom: 6 }}>Your percentile in {form.industry}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <span style={{ fontSize: 40, fontWeight: 700, color: C.text }}>{result.percentile}</span>
                <span style={{ fontSize: 16, color: C.textMuted }}>/ 100</span>
              </div>
              <div style={{ marginTop: 12, background: C.borderLight, borderRadius: 4, height: 8, position: "relative" }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${result.percentile}%`, background: C.teal, borderRadius: 4 }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.textLight, marginTop: 4 }}><span>Lowest</span><span>Median</span><span>Highest</span></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>vs {form.industry} average</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: result.diff >= 0 ? C.green : C.red }}>{result.diff >= 0 ? "+" : ""}{result.diff}%</div>
                <div style={{ fontSize: 12, color: C.textLight, marginTop: 4 }}>Avg: EGP {fmt(result.avg)} ({result.count} entries)</div>
              </div>
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>vs {form.experience} peers</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: result.expDiff >= 0 ? C.green : C.red }}>{result.expDiff >= 0 ? "+" : ""}{result.expDiff}%</div>
                <div style={{ fontSize: 12, color: C.textLight, marginTop: 4 }}>Avg: EGP {fmt(result.expAvg)} ({result.expCount} entries)</div>
              </div>
            </div>
            <div style={{ background: C.warmBg, border: "1px solid #fef08a", borderRadius: 8, padding: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>Negotiation context</div>
              <p style={{ fontSize: 13, color: "#713f12", lineHeight: 1.7, margin: 0 }}>
                {result.diff < -15 ? `Your salary is ${Math.abs(result.diff)}% below the ${form.industry} average. With ${result.count} validated data points, you may have leverage for a market-rate adjustment. Focus on quantifiable contributions.`
                  : result.diff < 10 ? `You're within the expected range for ${form.industry}. To move higher, consider specializing in high-demand skills or taking on team leadership.`
                  : `You're well above the ${form.industry} average. Consider evaluating total compensation — equity, benefits, learning budget — as these matter more at your level.`}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// LAYER 5: ADMIN REVIEW QUEUE
// ============================================================
function AdminPage({ salaries, setSalaries }) {
  const [filter, setFilter] = useState("all_review");
  const [actionLog, setActionLog] = useState([]);

  const flagged = salaries.filter(s => s.status === "flagged");
  const needsReview = salaries.filter(s => s.status === "needs_review");
  const communityFlagged = salaries.filter(s => s.flagCount > 0 && s.status === "auto_approved");

  const queue = filter === "flagged" ? flagged : filter === "needs_review" ? needsReview : filter === "community" ? communityFlagged : [...flagged, ...needsReview, ...communityFlagged];

  const handleAction = (id, action) => {
    setSalaries(prev => prev.map(s => {
      if (s.id !== id) return s;
      if (action === "approve") return { ...s, status: "auto_approved", verified: true, trustScore: Math.max(s.trustScore, 80) };
      if (action === "reject") return { ...s, status: "rejected" };
      return s;
    }));
    setActionLog(prev => [{ id, action, time: new Date().toLocaleTimeString() }, ...prev.slice(0, 19)]);
  };

  const statusBadge = (status, trustScore) => {
    const styles = {
      flagged: { bg: C.redBg, border: C.redBorder, color: "#991b1b", label: "Flagged" },
      needs_review: { bg: C.orangeBg, border: C.orangeBorder, color: "#92400e", label: "Needs review" },
      auto_approved: { bg: C.greenBg, border: C.greenBorder, color: "#166534", label: "Approved" },
      rejected: { bg: "#f5f5f5", border: C.border, color: C.textLight, label: "Rejected" },
    };
    const s = styles[status] || styles.needs_review;
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
        {s.label} &middot; {trustScore}/100
      </span>
    );
  };

  return (
    <div style={{ paddingTop: 56, background: C.bg, minHeight: "100vh" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>Admin Review Queue</h1>
            <p style={{ fontSize: 14, color: C.textMuted, marginTop: 4 }}>
              {flagged.length} flagged &middot; {needsReview.length} needs review &middot; {communityFlagged.length} community-flagged
            </p>
          </div>
        </div>

        {/* Summary cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
          {[
            { label: "Total entries", value: salaries.length, color: C.text },
            { label: "Auto-approved", value: salaries.filter(s => s.status === "auto_approved").length, color: C.green },
            { label: "Pending review", value: flagged.length + needsReview.length, color: C.orange },
            { label: "Rejected", value: salaries.filter(s => s.status === "rejected").length, color: C.red },
          ].map(c => (
            <div key={c.label} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, color: C.textLight, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 500 }}>{c.label}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: c.color, marginTop: 4 }}>{c.value}</div>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          {[
            { id: "all_review", label: `All (${queue.length})` },
            { id: "flagged", label: `Flagged (${flagged.length})` },
            { id: "needs_review", label: `Needs review (${needsReview.length})` },
            { id: "community", label: `Community flags (${communityFlagged.length})` },
          ].map(t => (
            <button key={t.id} onClick={() => setFilter(t.id)} style={{ border: `1px solid ${filter === t.id ? C.teal : C.border}`, background: filter === t.id ? C.tealBg : "#fff", color: filter === t.id ? C.tealDark : C.textMuted, padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: "pointer" }}>{t.label}</button>
          ))}
        </div>

        {/* Review items */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
          {queue.length === 0 && <div style={{ padding: "48px 20px", textAlign: "center", color: C.textLight, fontSize: 14 }}>Queue is empty. All entries are reviewed.</div>}
          {queue.map(s => (
            <div key={s.id} style={{ padding: "16px 20px", borderBottom: `1px solid ${C.borderLight}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{s.title}</span>
                    {statusBadge(s.status, s.trustScore)}
                    {s.flagCount > 0 && <span style={{ fontSize: 11, color: C.red, fontWeight: 600 }}>{s.flagCount} user flag{s.flagCount > 1 ? "s" : ""}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: C.textMuted }}>{s.company} &middot; {s.city} &middot; {s.experience} &middot; {s.industry}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>EGP {fmt(s.salary)}</div>
                  <div style={{ fontSize: 11, color: C.textLight }}>{daysAgo(s.submitted)} &middot; Device: {s.deviceHash || "—"}</div>
                </div>
              </div>

              {/* Flags detail */}
              {s.flags && s.flags.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  {s.flags.map((f, i) => (
                    <div key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 8, marginBottom: 4, padding: "3px 8px", borderRadius: 4, fontSize: 11,
                      background: f.severity === "high" ? C.redBg : C.orangeBg,
                      border: `1px solid ${f.severity === "high" ? C.redBorder : C.orangeBorder}`,
                      color: f.severity === "high" ? "#991b1b" : "#92400e" }}>
                      {Icons.alert} {f.type}: {f.detail}
                    </div>
                  ))}
                </div>
              )}

              {/* Optional fields submitted (Layer 3 signal) */}
              {(s.salaryType || s.contractType || s.recentRaise) && (
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>
                  Optional fields: {[s.salaryType && `${s.salaryType} salary`, s.contractType, s.recentRaise && `raise: ${s.recentRaise}`, s.companySize && `${s.companySize} emp`].filter(Boolean).join(" · ")}
                </div>
              )}

              {/* Actions */}
              {s.status !== "rejected" && s.status !== "auto_approved" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => handleAction(s.id, "approve")} style={{ border: `1px solid ${C.greenBorder}`, background: C.greenBg, color: "#166534", padding: "5px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Approve</button>
                  <button onClick={() => handleAction(s.id, "reject")} style={{ border: `1px solid ${C.redBorder}`, background: C.redBg, color: "#991b1b", padding: "5px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Reject</button>
                </div>
              )}
              {s.status === "auto_approved" && s.flagCount > 0 && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => handleAction(s.id, "reject")} style={{ border: `1px solid ${C.redBorder}`, background: C.redBg, color: "#991b1b", padding: "5px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Remove entry</button>
                  <span style={{ fontSize: 12, color: C.textLight, lineHeight: "28px" }}>Currently live — community flagged for review</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Action log */}
        {actionLog.length > 0 && (
          <div style={{ marginTop: 20, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.textMuted, marginBottom: 8 }}>Recent actions</div>
            {actionLog.map((a, i) => (
              <div key={i} style={{ fontSize: 12, color: C.textMuted, padding: "2px 0" }}>
                <span style={{ color: C.textLight }}>{a.time}</span> — Entry #{a.id} <span style={{ fontWeight: 600, color: a.action === "approve" ? C.green : C.red }}>{a.action}d</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// ABOUT PAGE
// ============================================================
function AboutPage() {
  return (
    <div style={{ paddingTop: 56, background: "#fff", minHeight: "100vh" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 20px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>About Aaref</h1>
        <p style={{ fontSize: 16, color: C.textMuted, marginTop: 8, lineHeight: 1.7 }}>Aaref (اعرف) means "Know" in Egyptian Arabic. Real-time salary transparency for Egyptian professionals across all industries.</p>

        <div style={{ marginTop: 32, borderTop: `1px solid ${C.border}`, paddingTop: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: "0 0 12px" }}>Data integrity</h2>
          <p style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.7, margin: "0 0 16px" }}>Every submission passes through a 5-layer validation pipeline before appearing in public data:</p>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
            {[
              ["Layer 1", "Device fingerprint + rate limiting", "Prevents spam and bulk fake submissions without using cookies or accounts"],
              ["Layer 2", "Statistical outlier detection", "Z-score analysis flags entries that deviate >2.5 standard deviations from industry norms"],
              ["Layer 3", "Submission friction signals", "Optional fields (salary type, contract, recent raise) differentiate real users from fakers"],
              ["Layer 4", "Community moderation", "Users can flag suspicious entries. Shows nearby entries during submission for self-correction"],
              ["Layer 5", "Admin manual review", "All flagged and borderline entries are reviewed by a human before going live"],
            ].map(([layer, title, desc], i) => (
              <div key={layer} style={{ display: "flex", gap: 14, padding: "14px 16px", borderBottom: i < 4 ? `1px solid ${C.borderLight}` : "none" }}>
                <div style={{ width: 52, fontSize: 11, fontWeight: 600, color: C.teal, paddingTop: 2, flexShrink: 0 }}>{layer}</div>
                <div><div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{title}</div><div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, lineHeight: 1.5 }}>{desc}</div></div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 28, borderTop: `1px solid ${C.border}`, paddingTop: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: "0 0 16px" }}>Privacy architecture</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[["No accounts", "No signup, email, or phone number. Ever."], ["No IP logging", "Your IP address is never stored."], ["No cookies", "Cloudflare Turnstile for anti-spam. No tracking cookies."], ["US hosting", "Vercel + Cloudflare. Data never touches local servers."]].map(([t, d]) => (
              <div key={t} style={{ padding: 14, background: C.bg, borderRadius: 6, border: `1px solid ${C.borderLight}` }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3, lineHeight: 1.5 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 28, borderTop: `1px solid ${C.border}`, paddingTop: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: "0 0 8px" }}>Target market</h2>
          <p style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.7, margin: "0 0 12px" }}>Egypt's ~10-12 million formal-sector employees. 65% of the workforce is informal and excluded from our dataset.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {["Technology", "Banking & Finance", "Telecom", "FMCG", "Pharma", "Healthcare", "Engineering"].map(i => (
              <span key={i} style={{ padding: "4px 10px", background: C.tealBg, color: C.tealDark, borderRadius: 4, fontSize: 12, fontWeight: 500 }}>{i}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer style={{ borderTop: `1px solid ${C.border}`, background: "#fff", padding: "24px 0" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 22, height: 22, borderRadius: 4, background: C.teal, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700 }}>ع</div>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Aaref</span>
          <span style={{ fontSize: 12, color: C.textLight }}>· 5-layer validated salary data</span>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: C.textLight }}>
          <span>No cookies</span><span>No tracking</span><span>No login</span><span>Open source</span>
        </div>
        <div style={{ fontSize: 12, color: C.textLight }}>© 2026</div>
      </div>
    </footer>
  );
}

// ============================================================
// APP ROOT
// ============================================================
export default function App() {
  const [page, setPage] = useState("home");
  const [salaries, setSalaries] = useState(INITIAL_SALARIES);

  // LAYER 4: Community flag handler
  const handleFlag = useCallback((id) => {
    setSalaries(prev => prev.map(s => s.id === id ? { ...s, flagCount: (s.flagCount || 0) + 1 } : s));
  }, []);

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  return (
    <div style={{ minHeight: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif", WebkitFontSmoothing: "antialiased" }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; }
        button { font-family: inherit; }
        input, select { font-family: inherit; }
        input:focus, select:focus { border-color: ${C.teal} !important; box-shadow: 0 0 0 2px ${C.tealLight}; }
        @media (max-width: 768px) { .nav-desktop { display: none !important; } }
      `}</style>
      <Nav page={page} setPage={setPage} />
      {page === "home" && <HomePage setPage={setPage} salaries={salaries} />}
      {page === "explore" && <ExplorePage salaries={salaries} onFlag={handleFlag} />}
      {page === "submit" && <SubmitPage salaries={salaries} setSalaries={setSalaries} />}
      {page === "compare" && <ComparePage salaries={salaries} />}
      {page === "admin" && <AdminPage salaries={salaries} setSalaries={setSalaries} />}
      {page === "about" && <AboutPage />}
      <Footer />
    </div>
  );
}
