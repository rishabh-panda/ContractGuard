import { useState, useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type View = "upload" | "processing" | "dashboard" | "report";

interface Flag {
  flagId: string;
  excerpt: string;
  location: string;
  risk: string;
  suggestedRedline: string;
}

interface Category {
  categoryId: string;
  label: string;
  score: number;
  severity: string;
  summary: string;
  flags: Flag[];
}

interface Analysis {
  analysisVersion: string;
  contractSummary: string;
  overallRiskScore: number;
  categories: Category[];
}

interface Decision {
  action: string;
  note: string;
  decidedAt: number;
}

const SEVERITY_COLOR: Record<string, string> = {
  none: "#22c55e",
  low: "#22c55e",
  moderate: "#f59e0b",
  high: "#ef4444",
  critical: "#dc2626",
};

function scoreColor(score: number) {
  if (score <= 3) return "#22c55e";
  if (score <= 6) return "#f59e0b";
  if (score <= 8) return "#ef4444";
  return "#dc2626";
}

const PROCESSING_MESSAGES = [
  "Extracting contract text...",
  "Identifying parties and key terms...",
  "Scanning auto-renewal and termination clauses...",
  "Analyzing IP ownership and data rights...",
  "Scoring indemnification and liability exposure...",
  "Compiling risk report...",
];

function isEnglish(text: string): boolean {
  const stopwords = ["the", "and", "of", "to", "a", "in", "that", "is", "for", "it", "with", "as", "be", "this"];
  const words = text.toLowerCase().split(/\s+/);
  const hits = words.filter((w) => stopwords.includes(w));
  return hits.length > 2;
}

export default function App() {
  const [view, setView] = useState<View>("upload");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [truncated, setTruncated] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [processingMsg, setProcessingMsg] = useState(0);
  const [pasteMode, setPasteMode] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [reportData, setReportData] = useState<{
    filename: string; uploadedAt: number; analysis: Analysis; decisions: Record<string, Decision>; truncated: boolean;
  } | null>(null);
  const [pendingFlag, setPendingFlag] = useState<Record<string, { action: string; note: string; submitting: boolean } | null>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showTooltip, setShowTooltip] = useState(false);
  const [nonEnglish, setNonEnglish] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const processingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailures = useRef(0);

  // Restore session from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("cg_sessionId");
    if (saved) {
      setSessionId(saved);
      fetch(`${BASE}/api/report/${saved}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.analysis) {
            setFilename(data.filename ?? "contract");
            setTruncated(data.truncated ?? false);
            setAnalysis(data.analysis);
            setDecisions(data.decisions ?? {});
            setView("dashboard");
          }
        })
        .catch(() => {});
    }
  }, []);

  const startProcessingMessages = useCallback(() => {
    setProcessingMsg(0);
    processingInterval.current = setInterval(() => {
      setProcessingMsg((m) => (m + 1) % PROCESSING_MESSAGES.length);
    }, 4000);
  }, []);

  const stopProcessingMessages = useCallback(() => {
    if (processingInterval.current) {
      clearInterval(processingInterval.current);
      processingInterval.current = null;
    }
  }, []);

  const handleUploadResponse = useCallback(async (data: { sessionId: string; filename: string; charCount: number; truncated: boolean }) => {
    const sid = data.sessionId;
    setSessionId(sid);
    setFilename(data.filename);
    setTruncated(data.truncated);
    localStorage.setItem("cg_sessionId", sid);
    setView("processing");
    startProcessingMessages();

    pollFailures.current = 0;

    const tryAnalyze = async () => {
      try {
        const res = await fetch(`${BASE}/api/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
        });
        const result = await res.json();
        pollFailures.current = 0;

        if (!res.ok || result.error) {
          stopProcessingMessages();
          setError(result.error ?? "Analysis failed. Please try again.");
          setView("upload");
          return;
        }

        stopProcessingMessages();
        const a = result.analysis as Analysis;
        setAnalysis(a);
        setNonEnglish(!isEnglish(a.contractSummary));
        setView("dashboard");
      } catch {
        pollFailures.current += 1;
        if (pollFailures.current >= 3) {
          stopProcessingMessages();
          setError("Network error. Please check your connection and try again.");
          setView("upload");
        }
      }
    };

    await tryAnalyze();
  }, [startProcessingMessages, stopProcessingMessages]);

  const uploadFile = useCallback(async (file: File) => {
    setError(null);
    if (file.size > 5 * 1024 * 1024) {
      setError("File exceeds 5 MB limit. Please upload a smaller file.");
      return;
    }
    if (!["application/pdf", "text/plain"].includes(file.type) && !file.name.endsWith(".txt")) {
      setError("Unsupported file type. Please upload a PDF or .txt file.");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok || data.error) {
      setError(data.error ?? "Upload failed. Please try again.");
      return;
    }
    await handleUploadResponse(data);
  }, [handleUploadResponse]);

  const uploadText = useCallback(async () => {
    setError(null);
    const text = pasteRef.current?.value ?? "";
    if (!text.trim()) {
      setError("Please paste your contract text.");
      return;
    }
    const res = await fetch(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: text,
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setError(data.error ?? "Upload failed. Please try again.");
      return;
    }
    await handleUploadResponse(data);
  }, [handleUploadResponse]);

  const submitDecision = useCallback(async (flagId: string) => {
    const pending = pendingFlag[flagId];
    if (!pending || !sessionId) return;
    setPendingFlag((p) => ({ ...p, [flagId]: { ...pending, submitting: true } }));
    const res = await fetch(`${BASE}/api/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, flagId, action: pending.action, note: pending.note }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      setDecisions(data.decisions);
      setPendingFlag((p) => ({ ...p, [flagId]: null }));
    } else {
      setPendingFlag((p) => ({ ...p, [flagId]: { ...pending, submitting: false } }));
    }
  }, [pendingFlag, sessionId]);

  const generateReport = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`${BASE}/api/report/${sessionId}`);
    const data = await res.json();
    if (res.ok && data.analysis) {
      setReportData({
        filename: data.filename,
        uploadedAt: data.uploadedAt,
        analysis: data.analysis,
        decisions: data.decisions,
        truncated: data.truncated,
      });
      setView("report");
    }
  }, [sessionId]);

  const resetApp = useCallback(() => {
    stopProcessingMessages();
    setView("upload");
    setError(null);
    setSessionId(null);
    setFilename("");
    setTruncated(false);
    setAnalysis(null);
    setDecisions({});
    setPasteMode(false);
    setReportData(null);
    setPendingFlag({});
    setCollapsed({});
    setNonEnglish(false);
    localStorage.removeItem("cg_sessionId");
  }, [stopProcessingMessages]);

  const allFlags = analysis
    ? analysis.categories.flatMap((c) => c.flags)
    : [];
  const totalFlags = allFlags.length;
  const reviewedFlags = allFlags.filter((f) => decisions[f.flagId]).length;
  const allReviewed = totalFlags > 0 && reviewedFlags === totalFlags;

  const actionLabel: Record<string, string> = {
    accept: "Accept Risk",
    escalate: "Escalate to Counsel",
    redline: "Request Redline",
  };

  return (
    <div style={{ fontFamily: "'Inter', 'Segoe UI', sans-serif", background: "#fff", color: "#111827", minHeight: "100vh" }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        body { margin: 0; }
        .container { max-width: 860px; margin: 0 auto; padding: 0 24px; }
        @media (max-width: 480px) { .container { padding: 0 12px; } }
        button { cursor: pointer; font-family: inherit; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        button:disabled:hover { background: inherit; }
        .btn-primary { background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 10px 20px; min-height: 44px; font-size: 14px; font-weight: 600; transition: background 0.15s; }
        .btn-primary:hover:not(:disabled) { background: #1d4ed8; }
        .btn-ghost { background: transparent; border: 1px solid #d1d5db; color: #374151; border-radius: 6px; padding: 8px 16px; min-height: 44px; font-size: 13px; font-weight: 500; transition: background 0.15s; }
        .btn-ghost:hover:not(:disabled) { background: #f9fafb; }
        .btn-action { border: 1.5px solid #d1d5db; border-radius: 6px; padding: 8px 16px; min-height: 44px; font-size: 13px; font-weight: 500; background: #fff; color: #374151; transition: all 0.15s; }
        .btn-action:hover:not(:disabled) { border-color: #2563eb; color: #2563eb; background: #eff6ff; }
        .btn-action.selected-accept { background: #f0fdf4; border-color: #22c55e; color: #15803d; font-weight: 600; }
        .btn-action.selected-escalate { background: #fff7ed; border-color: #f59e0b; color: #b45309; font-weight: 600; }
        .btn-action.selected-redline { background: #fef2f2; border-color: #ef4444; color: #b91c1c; font-weight: 600; }
        input[type="file"] { display: none; }
        *:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
        @media print {
          .no-print { display: none !important; }
          body { font-family: Georgia, serif; font-size: 12pt; }
          .print-section { page-break-inside: avoid; }
        }
        .spinner { width: 40px; height: 40px; border: 4px solid #e5e7eb; border-top-color: #2563eb; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 20px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .collapsible { max-height: 0; overflow: hidden; transition: max-height 0.25s ease; }
        .collapsible.open { max-height: 9999px; }
        .drop-zone { border: 2px dashed #d1d5db; border-radius: 12px; padding: 48px 24px; text-align: center; transition: all 0.15s; cursor: pointer; }
        .drop-zone.over { border-color: #2563eb; background: #eff6ff; }
        .badge { display: inline-block; padding: 2px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
        .severity-none { background: #f0fdf4; color: #15803d; }
        .severity-low { background: #f0fdf4; color: #15803d; }
        .severity-moderate { background: #fffbeb; color: #b45309; }
        .severity-high { background: #fef2f2; color: #b91c1c; }
        .severity-critical { background: #fff1f2; color: #9f1239; }
        .flag-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; margin-bottom: 14px; transition: opacity 0.2s; }
        .flag-card.decided { opacity: 0.7; background: #f9fafb; }
        blockquote { background: #f3f4f6; border-left: 3px solid #6b7280; margin: 12px 0; padding: 12px 16px; border-radius: 4px; font-family: 'Menlo', 'Courier New', monospace; font-size: 13px; color: #374151; word-break: break-word; white-space: pre-wrap; }
        .redline-box { background: #fffbeb; border: 1px solid #fbbf24; border-radius: 6px; padding: 12px 14px; font-size: 13px; color: #78350f; margin: 12px 0; }
        .redline-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #92400e; margin-bottom: 6px; }
        .progress-bar { background: #e5e7eb; border-radius: 99px; height: 6px; margin: 8px 0; }
        .progress-fill { background: #2563eb; border-radius: 99px; height: 6px; transition: width 0.3s; }
        .decision-locked { display: flex; align-items: center; gap: 10px; padding: 10px 0; flex-wrap: wrap; }
        .tooltip-wrap { position: relative; display: inline-block; }
        .tooltip { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); background: #1f2937; color: #fff; font-size: 12px; padding: 6px 10px; border-radius: 6px; white-space: nowrap; pointer-events: none; z-index: 100; }
      `}</style>

      {/* Header */}
      <header style={{ borderBottom: "1px solid #e5e7eb", padding: "16px 0" }}>
        <div className="container" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
              <rect width="28" height="28" rx="6" fill="#2563eb" />
              <path d="M8 8h12M8 12h12M8 16h8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
              <circle cx="20" cy="18" r="4" fill="#fff" />
              <path d="M18.5 18l1 1 2-2" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontWeight: 800, fontSize: 20, letterSpacing: "-0.01em", color: "#111827" }}>ContractGuard</span>
          </div>
          {view !== "upload" && (
            <button className="btn-ghost" onClick={resetApp} aria-label="Start over">
              ← New Contract
            </button>
          )}
        </div>
      </header>

      <main className="container" style={{ paddingTop: 32, paddingBottom: 64 }}>

        {/* ===== UPLOAD VIEW ===== */}
        {view === "upload" && (
          <div style={{ maxWidth: 560, margin: "0 auto" }}>
            <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8, letterSpacing: "-0.02em" }}>
              Contract Red-Flag Scanner
            </h1>
            <p style={{ color: "#6b7280", marginBottom: 32, lineHeight: 1.6 }}>
              Upload a vendor contract and get an AI-powered risk analysis across 10 legal categories — then review every flagged clause before generating your report.
            </p>

            {error && (
              <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#b91c1c", marginBottom: 20, fontSize: 14 }}>
                {error}
              </div>
            )}

            {nonEnglish && (
              <div style={{ background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 8, padding: "10px 14px", color: "#92400e", marginBottom: 16, fontSize: 13 }}>
                Best results on English-language contracts. Non-English contracts may have reduced accuracy.
              </div>
            )}

            <div style={{ marginBottom: 20, display: "flex", gap: 10 }}>
              <button
                className="btn-ghost"
                style={!pasteMode ? { borderColor: "#2563eb", color: "#2563eb", background: "#eff6ff" } : {}}
                onClick={() => setPasteMode(false)}
                aria-pressed={!pasteMode}
              >
                Upload File
              </button>
              <button
                className="btn-ghost"
                style={pasteMode ? { borderColor: "#2563eb", color: "#2563eb", background: "#eff6ff" } : {}}
                onClick={() => setPasteMode(true)}
                aria-pressed={pasteMode}
              >
                Paste Text
              </button>
            </div>

            {!pasteMode ? (
              <div>
                <div
                  className={`drop-zone${dragOver ? " over" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label="Upload contract file"
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click(); }}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files[0];
                    if (file) uploadFile(file);
                  }}
                >
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ margin: "0 auto 12px", display: "block" }} aria-hidden="true">
                    <path d="M20 4v22M12 12l8-8 8 8" stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M6 30v4a2 2 0 002 2h24a2 2 0 002-2v-4" stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                  <p style={{ margin: 0, fontWeight: 600, color: "#374151" }}>Drop your contract here</p>
                  <p style={{ margin: "6px 0 16px", color: "#9ca3af", fontSize: 13 }}>Accepts: PDF or plain text (.txt) up to 5 MB</p>
                  <button className="btn-primary" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }} type="button">
                    Choose File
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,application/pdf,text/plain"
                  aria-label="Select contract file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadFile(file);
                    e.target.value = "";
                  }}
                />
              </div>
            ) : (
              <div>
                <label htmlFor="contract-paste" style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>
                  Paste contract text
                </label>
                <textarea
                  id="contract-paste"
                  ref={pasteRef}
                  style={{ width: "100%", minHeight: 300, border: "1px solid #d1d5db", borderRadius: 8, padding: 12, fontSize: 13, fontFamily: "'Menlo','Courier New',monospace", resize: "vertical", color: "#111827" }}
                  placeholder="Paste your contract text here..."
                />
                <button className="btn-primary" style={{ marginTop: 12, width: "100%" }} onClick={uploadText}>
                  Analyze Contract
                </button>
              </div>
            )}
          </div>
        )}

        {/* ===== PROCESSING VIEW ===== */}
        {view === "processing" && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div className="spinner" role="status" aria-label="Analyzing contract" />
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Analyzing your contract</h2>
            <p style={{ color: "#6b7280", fontSize: 14, minHeight: 22, transition: "opacity 0.4s" }}>
              {PROCESSING_MESSAGES[processingMsg]}
            </p>
            <p style={{ color: "#9ca3af", fontSize: 12, marginTop: 24 }}>This may take up to 2 minutes for detailed analysis</p>
          </div>
        )}

        {/* ===== DASHBOARD VIEW ===== */}
        {view === "dashboard" && analysis && (
          <div>
            {truncated && (
              <div role="alert" style={{ background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 8, padding: "10px 16px", color: "#92400e", marginBottom: 20, fontSize: 13 }}>
                ⚠ This contract was truncated at 50,000 characters. Clauses beyond that point were not reviewed.
              </div>
            )}
            {nonEnglish && (
              <div style={{ background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", color: "#6b7280", marginBottom: 16, fontSize: 13 }}>
                Best results on English-language contracts. Non-English contracts may have reduced accuracy.
              </div>
            )}

            {/* Overall score */}
            <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 28, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Overall Risk Score</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontSize: 56, fontWeight: 900, color: scoreColor(analysis.overallRiskScore), lineHeight: 1 }}>
                    {analysis.overallRiskScore}
                  </span>
                  <span style={{ fontSize: 24, color: "#9ca3af", fontWeight: 300 }}>/10</span>
                  <span className={`badge severity-${analysis.categories.find(c => c.score === Math.max(...analysis.categories.map(x => x.score)))?.severity ?? "low"}`} style={{ fontSize: 13 }}>
                    {(analysis.categories.find(c => c.score === analysis.overallRiskScore)?.severity ?? "moderate").toUpperCase()}
                  </span>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <p style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6, margin: 0 }}>{analysis.contractSummary}</p>
              </div>
            </div>

            {/* Risk Matrix SVG */}
            <div style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Risk Matrix</h2>
              <svg
                width="100%"
                viewBox={`0 0 700 ${analysis.categories.length * 36 + 8}`}
                aria-label="Risk matrix chart"
                role="img"
                style={{ display: "block" }}
              >
                {analysis.categories.map((cat, i) => {
                  const y = i * 36;
                  const barMaxWidth = 480;
                  const barWidth = (cat.score / 10) * barMaxWidth;
                  const color = scoreColor(cat.score);
                  return (
                    <g
                      key={cat.categoryId}
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        if (cat.flags.length > 0) {
                          document.getElementById(`cat-${cat.categoryId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`${cat.label}: score ${cat.score}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") document.getElementById(`cat-${cat.categoryId}`)?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >
                      <text x="0" y={y + 22} fontSize="13" fill="#374151" fontFamily="'Inter','Segoe UI',sans-serif">{cat.label}</text>
                      <rect x="160" y={y + 8} width={barMaxWidth} height="18" rx="3" fill="#f3f4f6" />
                      <rect x="160" y={y + 8} width={Math.max(barWidth, 1)} height="18" rx="3" fill={color} />
                      <text x={160 + barWidth + 6} y={y + 22} fontSize="12" fill={color} fontWeight="700" fontFamily="'Inter','Segoe UI',sans-serif">{cat.score}</text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Progress tracker */}
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 18px", marginBottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {reviewedFlags} of {totalFlags} flag{totalFlags !== 1 ? "s" : ""} reviewed
                </div>
                <div className="progress-bar" style={{ width: 200 }}>
                  <div className="progress-fill" style={{ width: totalFlags > 0 ? `${(reviewedFlags / totalFlags) * 100}%` : "0%" }} />
                </div>
              </div>
              <div
                className="tooltip-wrap"
                onMouseEnter={() => !allReviewed && setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
              >
                <button
                  className="btn-primary"
                  disabled={!allReviewed}
                  onClick={generateReport}
                  aria-label={allReviewed ? "Generate report" : "Review all flagged clauses to unlock the report"}
                >
                  Generate Report
                </button>
                {showTooltip && !allReviewed && (
                  <div className="tooltip" role="tooltip">
                    Review all flagged clauses to unlock the report.
                  </div>
                )}
              </div>
            </div>

            {/* Flags panel */}
            <div>
              {analysis.categories.map((cat) => {
                const isCollapsed = collapsed[cat.categoryId];
                const hasFlagsToShow = cat.severity !== "none" && cat.flags.length > 0;

                return (
                  <div key={cat.categoryId} id={`cat-${cat.categoryId}`} style={{ marginBottom: 16 }}>
                    <button
                      style={{ width: "100%", background: "none", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", textAlign: "left" }}
                      onClick={() => setCollapsed((c) => ({ ...c, [cat.categoryId]: !c[cat.categoryId] }))}
                      aria-expanded={!isCollapsed}
                    >
                      <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{cat.label}</span>
                      <span className={`badge severity-${cat.severity}`}>{cat.severity.toUpperCase()}</span>
                      <span style={{ color: scoreColor(cat.score), fontWeight: 800, fontSize: 15, minWidth: 24, textAlign: "right" }}>{cat.score}</span>
                      {hasFlagsToShow && (
                        <span style={{ color: "#6b7280", fontSize: 12 }}>
                          {cat.flags.filter((f) => decisions[f.flagId]).length}/{cat.flags.length} reviewed
                        </span>
                      )}
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.2s", flexShrink: 0 }}>
                        <path d="M4 6l4 4 4-4" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>

                    <div className={`collapsible${!isCollapsed ? " open" : ""}`}>
                      <div style={{ padding: "12px 4px 0" }}>
                        <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 12px" }}>{cat.summary}</p>

                        {cat.flags.length === 0 ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#15803d", fontSize: 13, padding: "8px 0" }}>
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <circle cx="8" cy="8" r="7" stroke="#22c55e" strokeWidth="1.5" />
                              <path d="M5 8l2 2 4-4" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            No flags in this category.
                          </div>
                        ) : (
                          cat.flags.filter((f) => f.excerpt).map((flag) => {
                            const decided = decisions[flag.flagId];
                            const pending = pendingFlag[flag.flagId];

                            return (
                              <div key={flag.flagId} className={`flag-card${decided ? " decided" : ""}`}>
                                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8, gap: 12 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af" }}>{flag.location}</div>
                                  {decided && (
                                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 700, background: decided.action === "accept" ? "#f0fdf4" : decided.action === "escalate" ? "#fff7ed" : "#fef2f2", color: decided.action === "accept" ? "#15803d" : decided.action === "escalate" ? "#b45309" : "#b91c1c" }}>
                                      {actionLabel[decided.action] ?? decided.action}
                                    </span>
                                  )}
                                </div>

                                <blockquote>"{flag.excerpt}"</blockquote>

                                <p style={{ color: "#374151", fontSize: 14, lineHeight: 1.6, margin: "10px 0" }}>{flag.risk}</p>

                                <div className="redline-box">
                                  <div className="redline-label">Suggested alternative language</div>
                                  {flag.suggestedRedline}
                                </div>

                                {!decided ? (
                                  <div style={{ marginTop: 14 }}>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                      {(["accept", "escalate", "redline"] as const).map((action) => (
                                        <button
                                          key={action}
                                          className={`btn-action${pending?.action === action ? ` selected-${action}` : ""}`}
                                          onClick={() => setPendingFlag((p) => ({
                                            ...p,
                                            [flag.flagId]: { action, note: p[flag.flagId]?.note ?? "", submitting: false },
                                          }))}
                                          aria-pressed={pending?.action === action}
                                        >
                                          {actionLabel[action]}
                                        </button>
                                      ))}
                                    </div>
                                    {pending?.action && (
                                      <div style={{ marginTop: 12 }}>
                                        <label htmlFor={`note-${flag.flagId}`} style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 4 }}>
                                          Add a note (optional)
                                        </label>
                                        <textarea
                                          id={`note-${flag.flagId}`}
                                          style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", resize: "vertical", minHeight: 72, color: "#111827" }}
                                          placeholder="Add context or notes..."
                                          value={pending.note}
                                          onChange={(e) => setPendingFlag((p) => ({
                                            ...p,
                                            [flag.flagId]: { ...p[flag.flagId]!, note: e.target.value },
                                          }))}
                                        />
                                        <button
                                          className="btn-primary"
                                          style={{ marginTop: 8 }}
                                          disabled={pending.submitting}
                                          onClick={() => submitDecision(flag.flagId)}
                                        >
                                          {pending.submitting ? "Saving..." : "Confirm Decision"}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="decision-locked">
                                    <span style={{ fontSize: 12, color: "#9ca3af" }}>
                                      Decided {new Date(decided.decidedAt).toLocaleString()}
                                      {decided.note ? ` · "${decided.note}"` : ""}
                                    </span>
                                    <button
                                      className="btn-ghost"
                                      style={{ fontSize: 12, minHeight: 32, padding: "4px 12px" }}
                                      onClick={() => {
                                        setDecisions((d) => {
                                          const next = { ...d };
                                          delete next[flag.flagId];
                                          return next;
                                        });
                                      }}
                                    >
                                      Change decision
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ===== REPORT VIEW ===== */}
        {view === "report" && reportData && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }} className="no-print">
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Final Report</h2>
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn-primary no-print" onClick={() => window.print()}>
                  🖨 Print / Save PDF
                </button>
                <button className="btn-ghost no-print" onClick={() => setView("dashboard")}>
                  ← Back to Dashboard
                </button>
              </div>
            </div>

            {/* Print header */}
            <div style={{ borderBottom: "2px solid #111827", paddingBottom: 16, marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span style={{ fontWeight: 900, fontSize: 22, letterSpacing: "-0.02em" }}>ContractGuard</span>
                <span style={{ color: "#6b7280", fontSize: 14 }}>Risk Analysis Report</span>
              </div>
              <div style={{ color: "#6b7280", fontSize: 13 }}>
                <span>Contract: <strong>{reportData.filename}</strong></span>
                <span style={{ margin: "0 12px" }}>·</span>
                <span>Analyzed: {new Date(reportData.uploadedAt).toLocaleString()}</span>
              </div>
            </div>

            {reportData.truncated && (
              <div style={{ background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 8, padding: "10px 14px", color: "#92400e", marginBottom: 20, fontSize: 13 }}>
                ⚠ This contract was truncated at 50,000 characters. Clauses beyond that point were not reviewed.
              </div>
            )}

            {/* Overall score */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
                <span style={{ fontSize: 48, fontWeight: 900, color: scoreColor(reportData.analysis.overallRiskScore) }}>
                  {reportData.analysis.overallRiskScore}
                </span>
                <span style={{ color: "#9ca3af", fontSize: 20 }}>/10 Overall Risk</span>
              </div>
              <p style={{ color: "#374151", lineHeight: 1.6, margin: 0 }}>{reportData.analysis.contractSummary}</p>
            </div>

            {/* Category table */}
            <div style={{ marginBottom: 32 }} className="print-section">
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, borderBottom: "1px solid #e5e7eb", paddingBottom: 8 }}>Risk Summary</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f9fafb" }}>
                    <th style={{ textAlign: "left", padding: "8px 12px", border: "1px solid #e5e7eb", fontWeight: 700 }}>Category</th>
                    <th style={{ textAlign: "center", padding: "8px 12px", border: "1px solid #e5e7eb", fontWeight: 700 }}>Score</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", border: "1px solid #e5e7eb", fontWeight: 700 }}>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {reportData.analysis.categories.map((cat) => (
                    <tr key={cat.categoryId}>
                      <td style={{ padding: "8px 12px", border: "1px solid #e5e7eb", fontWeight: 600 }}>
                        <span className={`badge severity-${cat.severity}`} style={{ marginRight: 8 }}>{cat.severity.slice(0, 1).toUpperCase()}</span>
                        {cat.label}
                      </td>
                      <td style={{ padding: "8px 12px", border: "1px solid #e5e7eb", textAlign: "center", fontWeight: 800, color: scoreColor(cat.score) }}>
                        {cat.score}
                      </td>
                      <td style={{ padding: "8px 12px", border: "1px solid #e5e7eb", color: "#6b7280" }}>{cat.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Per-flag breakdown */}
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, borderBottom: "1px solid #e5e7eb", paddingBottom: 8 }}>Flag-by-Flag Review</h3>
              {reportData.analysis.categories.flatMap((cat) =>
                cat.flags.filter((f) => f.excerpt).map((flag) => {
                  const dec = reportData.decisions[flag.flagId];
                  return (
                    <div key={flag.flagId} className="print-section" style={{ marginBottom: 24, paddingBottom: 24, borderBottom: "1px solid #f3f4f6" }}>
                      <div style={{ display: "flex", gap: 10, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{cat.label}</span>
                        <span style={{ color: "#9ca3af", fontSize: 12 }}>·</span>
                        <span style={{ color: "#6b7280", fontSize: 12 }}>{flag.location}</span>
                        {dec && (
                          <span style={{ marginLeft: "auto", fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 700, background: dec.action === "accept" ? "#f0fdf4" : dec.action === "escalate" ? "#fff7ed" : "#fef2f2", color: dec.action === "accept" ? "#15803d" : dec.action === "escalate" ? "#b45309" : "#b91c1c" }}>
                            {actionLabel[dec.action] ?? dec.action}
                          </span>
                        )}
                      </div>
                      <blockquote style={{ margin: "8px 0", fontSize: 12 }}>"{flag.excerpt}"</blockquote>
                      <p style={{ fontSize: 13, color: "#374151", lineHeight: 1.5, margin: "8px 0" }}>{flag.risk}</p>
                      {dec?.note && (
                        <p style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic", margin: "6px 0 0" }}>
                          Reviewer note: "{dec.note}"
                        </p>
                      )}
                    </div>
                  );
                })
              )}
              {reportData.analysis.categories.every((c) => c.flags.length === 0) && (
                <p style={{ color: "#6b7280", fontSize: 14 }}>No flags were identified in this contract.</p>
              )}
            </div>

            {/* Footer */}
            <div style={{ marginTop: 40, paddingTop: 20, borderTop: "1px solid #e5e7eb", fontSize: 12, color: "#9ca3af", lineHeight: 1.6 }}>
              <p>This report was generated by ContractGuard. It does not constitute legal advice. All decisions were made by a human reviewer.</p>
              <p>Sessions are not persisted across server restarts.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
