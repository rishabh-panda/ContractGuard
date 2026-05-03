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

function scoreColor(score: number) {
  if (score <= 3) return "#22c55e";
  if (score <= 6) return "#f59e0b";
  if (score <= 8) return "#ef4444";
  return "#dc2626";
}

function scoreSeverity(score: number): string {
  if (score === 0) return "none";
  if (score <= 3) return "low";
  if (score <= 6) return "moderate";
  if (score <= 8) return "high";
  return "critical";
}

const PROCESSING_MESSAGES = [
  "Extracting contract text...",
  "Identifying parties and key terms...",
  "Scanning auto-renewal and termination clauses...",
  "Analyzing IP ownership and data rights...",
  "Scoring indemnification and liability exposure...",
  "Compiling risk report...",
];

const ACTION_LABEL: Record<string, string> = {
  accept: "Accept Risk",
  escalate: "Escalate to Counsel",
  redline: "Request Redline",
};

const ACTION_COLORS: Record<string, { bg: string; border: string; color: string }> = {
  accept:   { bg: "#f0fdf4", border: "#22c55e",  color: "#15803d" },
  escalate: { bg: "#fff7ed", border: "#f59e0b",  color: "#b45309" },
  redline:  { bg: "#fef2f2", border: "#ef4444",  color: "#b91c1c" },
};

function isEnglish(text: string): boolean {
  const stopwords = ["the", "and", "of", "to", "a", "in", "that", "is", "for", "it", "with", "as", "be", "this"];
  const words = text.toLowerCase().split(/\s+/);
  return words.filter((w) => stopwords.includes(w)).length > 2;
}

// Build initial collapsed state: categories with no flags start collapsed
function buildInitialCollapsed(categories: Category[]): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const cat of categories) {
    const hasFlags = cat.flags.filter((f) => f.excerpt).length > 0;
    state[cat.categoryId] = !hasFlags; // collapsed if no flags
  }
  return state;
}

export default function App() {
  const [view, setView] = useState<View>("upload");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [largeDocument, setLargeDocument] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [processingMsg, setProcessingMsg] = useState(0);
  const [pasteMode, setPasteMode] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [reportData, setReportData] = useState<{
    filename: string;
    uploadedAt: number;
    generatedAt: number;
    analysis: Analysis;
    decisions: Record<string, Decision>;
    truncated: boolean;
  } | null>(null);
  const [pendingFlag, setPendingFlag] = useState<Record<string, { action: string; note: string; submitting: boolean } | null>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [nonEnglish, setNonEnglish] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const processingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailures = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  // Restore session from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("cg_sessionId");
    if (saved) {
      fetch(`${BASE}/api/report/${saved}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.analysis) {
            setSessionId(saved);
            setFilename(data.filename ?? "contract");
            setTruncated(data.truncated ?? false);
            setAnalysis(data.analysis);
            setDecisions(data.decisions ?? {});
            setCollapsed(buildInitialCollapsed(data.analysis.categories));
            setView("dashboard");
          } else {
            localStorage.removeItem("cg_sessionId");
          }
        })
        .catch(() => { localStorage.removeItem("cg_sessionId"); });
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (processingInterval.current) clearInterval(processingInterval.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
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

  const handleUploadResponse = useCallback(async (data: {
    sessionId: string; filename: string; charCount: number; truncated: boolean;
  }) => {
    const sid = data.sessionId;
    setSessionId(sid);
    setFilename(data.filename);
    setTruncated(data.truncated);
    localStorage.setItem("cg_sessionId", sid);
    setView("processing");
    setError(null);
    startProcessingMessages();
    pollFailures.current = 0;

    const controller = new AbortController();
    abortRef.current = controller;

    const tryAnalyze = async () => {
      try {
        const res = await fetch(`${BASE}/api/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
          signal: controller.signal,
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
        setLargeDocument(result.largeDocument ?? false);
        setNonEnglish(!isEnglish(a.contractSummary));
        setCollapsed(buildInitialCollapsed(a.categories));
        setView("dashboard");
      } catch (err: unknown) {
        if ((err as Error)?.name === "AbortError") return; // user cancelled
        pollFailures.current += 1;
        if (pollFailures.current >= 3) {
          stopProcessingMessages();
          setError("Network error after 3 attempts. Please check your connection.");
          setView("upload");
        } else {
          // Brief pause then retry (per spec: poll every 5s on failure)
          setTimeout(() => tryAnalyze(), 5000);
        }
      }
    };

    await tryAnalyze();
  }, [startProcessingMessages, stopProcessingMessages]);

  const cancelAnalysis = useCallback(() => {
    abortRef.current?.abort();
    stopProcessingMessages();
    setView("upload");
    setError(null);
  }, [stopProcessingMessages]);

  const uploadFile = useCallback(async (file: File) => {
    setError(null);
    if (file.size > 5 * 1024 * 1024) {
      setError("File exceeds 5 MB limit. Please upload a smaller file.");
      return;
    }
    const isValidMime = ["application/pdf", "text/plain"].includes(file.type);
    const isValidExt = file.name.endsWith(".pdf") || file.name.endsWith(".txt");
    if (!isValidMime && !isValidExt) {
      setError("Unsupported file type. Please upload a PDF or .txt file.");
      return;
    }
    setSelectedFile(file.name);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "Upload failed. Please try again.");
        setSelectedFile(null);
        return;
      }
      await handleUploadResponse(data);
    } catch {
      setError("Upload failed. Please check your connection and try again.");
      setSelectedFile(null);
    }
  }, [handleUploadResponse]);

  const uploadText = useCallback(async () => {
    setError(null);
    const text = pasteRef.current?.value ?? "";
    if (!text.trim()) {
      setError("Please paste your contract text before analyzing.");
      return;
    }
    try {
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
    } catch {
      setError("Upload failed. Please check your connection and try again.");
    }
  }, [handleUploadResponse]);

  const submitDecision = useCallback(async (flagId: string) => {
    const pending = pendingFlag[flagId];
    if (!pending || !sessionId) return;
    setPendingFlag((p) => ({ ...p, [flagId]: { ...pending, submitting: true } }));
    try {
      const res = await fetch(`${BASE}/api/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, flagId, action: pending.action, note: pending.note }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setDecisions(data.decisions);
        setPendingFlag((p) => ({ ...p, [flagId]: null }));
        showToast(`Decision saved: ${ACTION_LABEL[pending.action] ?? pending.action}`);
      } else {
        setPendingFlag((p) => ({ ...p, [flagId]: { ...pending, submitting: false } }));
        setError("Failed to save decision. Please try again.");
      }
    } catch {
      setPendingFlag((p) => ({ ...p, [flagId]: { ...pending, submitting: false } }));
      setError("Network error. Failed to save decision.");
    }
  }, [pendingFlag, sessionId, showToast]);

  // When user clears a decision, also sync to server by removing it
  const clearDecision = useCallback(async (flagId: string) => {
    if (!sessionId) return;
    setDecisions((d) => {
      const next = { ...d };
      delete next[flagId];
      return next;
    });
    // Notify server — if it fails it's not critical (session has 30min TTL)
    fetch(`${BASE}/api/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, flagId, action: "__cleared__", note: "" }),
    }).catch(() => {});
  }, [sessionId]);

  const generateReport = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${BASE}/api/report/${sessionId}`);
      const data = await res.json();
      if (res.ok && data.analysis) {
        // Merge local decisions (may be more current than server) into report
        const mergedDecisions = { ...data.decisions };
        for (const [flagId, dec] of Object.entries(decisions)) {
          if (dec.action !== "__cleared__") mergedDecisions[flagId] = dec;
        }
        setReportData({
          filename: data.filename,
          uploadedAt: data.uploadedAt,
          generatedAt: Date.now(),
          analysis: data.analysis,
          decisions: mergedDecisions,
          truncated: data.truncated,
        });
        setView("report");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        setError(data.error ?? "Could not generate report. Please try again.");
      }
    } catch {
      setError("Network error. Could not generate report.");
    }
  }, [sessionId, decisions]);

  const resetApp = useCallback(() => {
    stopProcessingMessages();
    abortRef.current?.abort();
    // Clean up session on server
    const sid = sessionId;
    if (sid) {
      fetch(`${BASE}/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
    }
    localStorage.removeItem("cg_sessionId");
    setView("upload");
    setError(null);
    setSessionId(null);
    setFilename("");
    setSelectedFile(null);
    setTruncated(false);
    setLargeDocument(false);
    setAnalysis(null);
    setDecisions({});
    setPasteMode(false);
    setReportData(null);
    setPendingFlag({});
    setCollapsed({});
    setNonEnglish(false);
    setToast(null);
  }, [stopProcessingMessages, sessionId]);

  const allVisibleFlags = analysis
    ? analysis.categories.flatMap((c) => c.flags.filter((f) => f.excerpt))
    : [];
  const totalFlags = allVisibleFlags.length;
  // FIX: 0 flags means contract is clean — report should be unlocked
  const reviewedFlags = allVisibleFlags.filter((f) => decisions[f.flagId] && decisions[f.flagId].action !== "__cleared__").length;
  const allReviewed = reviewedFlags === totalFlags;

  const overallSeverity = analysis ? scoreSeverity(analysis.overallRiskScore) : "none";

  return (
    <div style={{ fontFamily: "'Inter','Segoe UI',sans-serif", background: "#fff", color: "#111827", minHeight: "100vh" }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        body { margin: 0; }
        .container { max-width: 860px; margin: 0 auto; padding: 0 24px; }
        @media (max-width: 480px) { .container { padding: 0 14px; } }
        button { cursor: pointer; font-family: inherit; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-primary { background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 10px 20px; min-height: 44px; font-size: 14px; font-weight: 600; transition: background 0.15s; }
        .btn-primary:hover:not(:disabled) { background: #1d4ed8; }
        .btn-ghost { background: transparent; border: 1px solid #d1d5db; color: #374151; border-radius: 6px; padding: 8px 16px; min-height: 44px; font-size: 13px; font-weight: 500; transition: all 0.15s; }
        .btn-ghost:hover:not(:disabled) { background: #f9fafb; border-color: #9ca3af; }
        .btn-danger-ghost { background: transparent; border: 1px solid #fca5a5; color: #dc2626; border-radius: 6px; padding: 8px 16px; min-height: 44px; font-size: 13px; font-weight: 500; transition: all 0.15s; }
        .btn-danger-ghost:hover:not(:disabled) { background: #fef2f2; }
        .btn-action { border: 1.5px solid #d1d5db; border-radius: 6px; padding: 8px 16px; min-height: 44px; font-size: 13px; font-weight: 500; background: #fff; color: #374151; transition: all 0.15s; }
        .btn-action:hover:not(:disabled) { border-color: #2563eb; color: #2563eb; background: #eff6ff; }
        .btn-action.sel-accept   { background: #f0fdf4; border-color: #22c55e; color: #15803d; font-weight: 700; }
        .btn-action.sel-escalate { background: #fff7ed; border-color: #f59e0b; color: #b45309; font-weight: 700; }
        .btn-action.sel-redline  { background: #fef2f2; border-color: #ef4444; color: #b91c1c; font-weight: 700; }
        input[type="file"] { display: none; }
        *:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
        @media print {
          .no-print { display: none !important; }
          body { font-family: Georgia, serif; font-size: 11pt; color: #000; }
          .print-break { page-break-before: always; }
          .print-section { page-break-inside: avoid; }
          blockquote { border: 1px solid #ccc !important; }
        }
        .spinner { width: 44px; height: 44px; border: 4px solid #e5e7eb; border-top-color: #2563eb; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 24px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .collapsible { overflow: hidden; max-height: 0; transition: max-height 0.28s ease; }
        .collapsible.open { max-height: 4000px; }
        .drop-zone { border: 2px dashed #d1d5db; border-radius: 12px; padding: 48px 24px; text-align: center; transition: all 0.15s; cursor: pointer; }
        .drop-zone.over { border-color: #2563eb; background: #eff6ff; }
        .drop-zone:hover { border-color: #93c5fd; }
        .badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 99px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; line-height: 1; }
        .sev-none     { background: #f0fdf4; color: #15803d; }
        .sev-low      { background: #f0fdf4; color: #15803d; }
        .sev-moderate { background: #fffbeb; color: #b45309; }
        .sev-high     { background: #fef2f2; color: #b91c1c; }
        .sev-critical { background: #fff1f2; color: #9f1239; }
        .flag-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; margin-bottom: 14px; transition: background 0.2s, border-color 0.2s; }
        .flag-card.decided { background: #f9fafb; border-color: #f3f4f6; }
        .flag-card.decided-accept   { border-left: 3px solid #22c55e; }
        .flag-card.decided-escalate { border-left: 3px solid #f59e0b; }
        .flag-card.decided-redline  { border-left: 3px solid #ef4444; }
        blockquote { background: #f3f4f6; border-left: 3px solid #6b7280; margin: 12px 0; padding: 12px 16px; border-radius: 0 4px 4px 0; font-family: 'Menlo','Courier New',monospace; font-size: 13px; color: #374151; word-break: break-word; white-space: pre-wrap; line-height: 1.5; }
        .redline-box { background: #fffbeb; border: 1px solid #fbbf24; border-radius: 6px; padding: 12px 14px; font-size: 13px; color: #78350f; margin: 12px 0; line-height: 1.5; }
        .redline-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #92400e; margin-bottom: 6px; }
        .progress-bar { background: #e5e7eb; border-radius: 99px; height: 6px; margin: 8px 0; }
        .progress-fill { background: #2563eb; border-radius: 99px; height: 6px; transition: width 0.4s ease; }
        .cat-toggle { width: 100%; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 18px; display: flex; align-items: center; gap: 10px; cursor: pointer; text-align: left; transition: background 0.12s, border-color 0.12s; }
        .cat-toggle:hover { background: #f9fafb; border-color: #d1d5db; }
        .cat-toggle:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
        .decision-locked { display: flex; align-items: center; gap: 10px; padding: 10px 0; flex-wrap: wrap; }
        .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #1f2937; color: #fff; font-size: 13px; font-weight: 500; padding: 10px 20px; border-radius: 8px; z-index: 1000; pointer-events: none; box-shadow: 0 4px 12px rgba(0,0,0,0.18); white-space: nowrap; animation: fadeInUp 0.2s ease; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        .scroll-top { position: fixed; bottom: 24px; right: 24px; background: #2563eb; color: #fff; border: none; border-radius: 50%; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.15); transition: background 0.15s; z-index: 50; }
        .scroll-top:hover { background: #1d4ed8; }
        .file-selected-chip { display: inline-flex; align-items: center; gap: 6px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 6px 12px; font-size: 13px; color: #1d4ed8; font-weight: 500; margin-top: 12px; word-break: break-all; }
        .no-wrap { white-space: nowrap; }
        .tooltip-container { position: relative; }
        .tooltip-bubble { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); background: #1f2937; color: #fff; font-size: 12px; padding: 6px 12px; border-radius: 6px; white-space: nowrap; pointer-events: none; z-index: 100; }
        @media (max-width: 480px) {
          .cat-toggle { flex-wrap: wrap; gap: 6px; }
          .flag-card { padding: 14px; }
          blockquote { font-size: 12px; }
          .scroll-top { bottom: 16px; right: 16px; }
        }
      `}</style>

      {/* Toast */}
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}

      {/* Scroll to top (dashboard only) */}
      {view === "dashboard" && (
        <button
          className="scroll-top no-print"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Scroll to top"
          title="Scroll to top"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 12V4M4 8l4-4 4 4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {/* Header */}
      <header style={{ borderBottom: "1px solid #e5e7eb", padding: "14px 0", position: "sticky", top: 0, background: "#fff", zIndex: 40 }}>
        <div className="container" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
              <rect width="30" height="30" rx="7" fill="#2563eb" />
              <path d="M9 9h12M9 13.5h12M9 18h8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
              <circle cx="21" cy="20" r="4.5" fill="#fff" />
              <path d="M19.3 20l1.2 1.2 2.2-2.4" stroke="#2563eb" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.01em", color: "#111827" }}>ContractGuard</span>
              <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 8, fontWeight: 500, display: "none" }} className="tagline">Vendor Risk Scanner</span>
            </div>
          </div>
          {view !== "upload" && (
            <button className="btn-ghost" onClick={resetApp} aria-label="Start a new contract analysis">
              ← New Contract
            </button>
          )}
        </div>
      </header>

      <main className="container" style={{ paddingTop: 36, paddingBottom: 80 }}>

        {/* ===== UPLOAD VIEW ===== */}
        {view === "upload" && (
          <div style={{ maxWidth: 560, margin: "0 auto" }}>
            <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8, letterSpacing: "-0.02em" }}>
              Contract Red-Flag Scanner
            </h1>
            <p style={{ color: "#6b7280", marginBottom: 32, lineHeight: 1.65, fontSize: 15 }}>
              Upload a vendor contract and get an AI-powered risk analysis across 10 legal categories — then review every flagged clause before generating your report.
            </p>

            {error && (
              <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#b91c1c", marginBottom: 20, fontSize: 14, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <span>{error}</span>
                <button
                  onClick={() => setError(null)}
                  style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", padding: 0, fontSize: 18, lineHeight: 1, flexShrink: 0 }}
                  aria-label="Dismiss error"
                >×</button>
              </div>
            )}

            <div style={{ marginBottom: 20, display: "flex", gap: 8 }}>
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
                  aria-label="Upload contract file. Drag and drop or click to choose."
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click(); }}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files[0];
                    if (file) uploadFile(file);
                  }}
                >
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ margin: "0 auto 12px", display: "block" }} aria-hidden="true">
                    <path d="M20 6v22M12 14l8-8 8 8" stroke={dragOver ? "#2563eb" : "#9ca3af"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M6 32v2a2 2 0 002 2h24a2 2 0 002-2v-2" stroke={dragOver ? "#2563eb" : "#9ca3af"} strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                  <p style={{ margin: 0, fontWeight: 600, color: dragOver ? "#2563eb" : "#374151", fontSize: 15 }}>
                    {dragOver ? "Drop to upload" : "Drop your contract here"}
                  </p>
                  <p style={{ margin: "6px 0 18px", color: "#9ca3af", fontSize: 13 }}>Accepts: PDF or plain text (.txt) up to 5 MB</p>
                  <button
                    className="btn-primary"
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    type="button"
                  >
                    Choose File
                  </button>
                </div>

                {selectedFile && (
                  <div className="file-selected-chip">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="M8 1H3a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V5L8 1z" stroke="#2563eb" strokeWidth="1.5" strokeLinejoin="round" />
                      <path d="M8 1v4h4" stroke="#2563eb" strokeWidth="1.5" strokeLinejoin="round" />
                    </svg>
                    {selectedFile}
                  </div>
                )}

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
                <label htmlFor="contract-paste" style={{ display: "block", fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
                  Paste contract text
                </label>
                <textarea
                  id="contract-paste"
                  ref={pasteRef}
                  style={{ width: "100%", minHeight: 300, border: "1px solid #d1d5db", borderRadius: 8, padding: 12, fontSize: 13, fontFamily: "'Menlo','Courier New',monospace", resize: "vertical", color: "#111827", lineHeight: 1.6 }}
                  placeholder="Paste your contract text here..."
                />
                <button className="btn-primary" style={{ marginTop: 12, width: "100%", fontSize: 15 }} onClick={uploadText}>
                  Analyze Contract
                </button>
              </div>
            )}

            <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 24, lineHeight: 1.5 }}>
              ContractGuard uses AI to identify risk signals. It does not provide legal advice.
              Sessions expire after 30 minutes.
            </p>
          </div>
        )}

        {/* ===== PROCESSING VIEW ===== */}
        {view === "processing" && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div className="spinner" role="status" aria-label="Analyzing contract" />
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Analyzing your contract</h2>
            {filename && (
              <p style={{ color: "#374151", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>
                📄 {filename}
              </p>
            )}
            <p style={{ color: "#6b7280", fontSize: 14, minHeight: 24, transition: "opacity 0.4s" }}>
              {PROCESSING_MESSAGES[processingMsg]}
            </p>
            <p style={{ color: "#9ca3af", fontSize: 12, marginTop: 12 }}>
              This may take up to 2 minutes for detailed analysis
            </p>
            <button
              className="btn-ghost"
              style={{ marginTop: 28, fontSize: 13 }}
              onClick={cancelAnalysis}
            >
              Cancel
            </button>
          </div>
        )}

        {/* ===== DASHBOARD VIEW ===== */}
        {view === "dashboard" && analysis && (
          <div>
            {/* Banners */}
            {largeDocument && (
              <div role="status" style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "10px 16px", color: "#1d4ed8", marginBottom: 12, fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <span>⏳</span>
                <span>Large document — analysis was performed in multiple sections. Review all flags carefully.</span>
              </div>
            )}
            {truncated && (
              <div role="alert" style={{ background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 8, padding: "10px 16px", color: "#92400e", marginBottom: 12, fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <span>⚠</span>
                <span>This contract was truncated at 50,000 characters. Clauses beyond that point were not reviewed.</span>
              </div>
            )}
            {nonEnglish && (
              <div style={{ background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", color: "#374151", marginBottom: 12, fontSize: 13 }}>
                ℹ Best results on English-language contracts. Non-English contracts may have reduced accuracy.
              </div>
            )}

            {/* Overall score */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 24, marginBottom: 32, flexWrap: "wrap", borderBottom: "1px solid #f3f4f6", paddingBottom: 28 }}>
              <div style={{ flexShrink: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Overall Risk Score</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 64, fontWeight: 900, color: scoreColor(analysis.overallRiskScore), lineHeight: 1 }}>
                    {analysis.overallRiskScore}
                  </span>
                  <span style={{ fontSize: 22, color: "#d1d5db", fontWeight: 300 }}>/10</span>
                </div>
                <span className={`badge sev-${overallSeverity}`} style={{ marginTop: 6 }}>
                  {overallSeverity.toUpperCase()}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Contract Summary</div>
                <p style={{ color: "#374151", fontSize: 14, lineHeight: 1.7, margin: 0 }}>{analysis.contractSummary}</p>
                <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 8, margin: "8px 0 0" }}>📄 {filename}</p>
              </div>
            </div>

            {/* Risk Matrix SVG */}
            <div style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>Risk Matrix</h2>
              <div style={{ overflowX: "auto" }}>
                <svg
                  width="100%"
                  viewBox={`0 0 680 ${analysis.categories.length * 36 + 8}`}
                  aria-label="Risk matrix chart showing scores for all 10 risk categories"
                  role="img"
                  style={{ display: "block", minWidth: 320 }}
                >
                  {analysis.categories.map((cat, i) => {
                    const y = i * 36;
                    const barMax = 460;
                    const barW = (cat.score / 10) * barMax;
                    const color = scoreColor(cat.score);
                    return (
                      <g
                        key={cat.categoryId}
                        style={{ cursor: cat.flags.length > 0 ? "pointer" : "default" }}
                        onClick={() => {
                          document.getElementById(`cat-${cat.categoryId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }}
                        role={cat.flags.length > 0 ? "button" : undefined}
                        tabIndex={cat.flags.length > 0 ? 0 : undefined}
                        aria-label={`${cat.label}: score ${cat.score} out of 10 (${cat.severity})`}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            document.getElementById(`cat-${cat.categoryId}`)?.scrollIntoView({ behavior: "smooth" });
                          }
                        }}
                      >
                        <text x="0" y={y + 22} fontSize="12.5" fill="#374151" fontFamily="'Inter','Segoe UI',sans-serif" fontWeight="500">{cat.label}</text>
                        <rect x="168" y={y + 7} width={barMax} height="20" rx="4" fill="#f3f4f6" />
                        <rect x="168" y={y + 7} width={Math.max(barW, 2)} height="20" rx="4" fill={color} />
                        <text x={168 + barW + 7} y={y + 22} fontSize="12" fill={color} fontWeight="800" fontFamily="'Inter','Segoe UI',sans-serif">{cat.score}</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>

            {/* Progress tracker + Generate Report */}
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 20px", marginBottom: 28, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>
                  {totalFlags === 0
                    ? <span style={{ color: "#15803d" }}>✓ No flags to review — contract looks clean</span>
                    : `${reviewedFlags} of ${totalFlags} flag${totalFlags !== 1 ? "s" : ""} reviewed`}
                </div>
                {totalFlags > 0 && (
                  <div className="progress-bar" style={{ width: "100%", maxWidth: 260 }}>
                    <div className="progress-fill" style={{ width: `${(reviewedFlags / totalFlags) * 100}%` }} />
                  </div>
                )}
              </div>
              <div className="tooltip-container">
                <button
                  className="btn-primary"
                  disabled={!allReviewed}
                  onClick={generateReport}
                  aria-label={allReviewed ? "Generate final report" : "Review all flagged clauses to unlock the report"}
                  aria-disabled={!allReviewed}
                >
                  Generate Report
                </button>
                {!allReviewed && (
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6, textAlign: "right" }}>
                    {totalFlags - reviewedFlags} flag{totalFlags - reviewedFlags !== 1 ? "s" : ""} remaining
                  </div>
                )}
              </div>
            </div>

            {/* Flags panel */}
            <div>
              {analysis.categories.map((cat) => {
                const isOpen = !collapsed[cat.categoryId];
                const visibleFlags = cat.flags.filter((f) => f.excerpt);
                const reviewedInCat = visibleFlags.filter((f) => decisions[f.flagId] && decisions[f.flagId].action !== "__cleared__").length;

                return (
                  <div key={cat.categoryId} id={`cat-${cat.categoryId}`} style={{ marginBottom: 12 }}>
                    <button
                      className="cat-toggle"
                      onClick={() => setCollapsed((c) => ({ ...c, [cat.categoryId]: !c[cat.categoryId] }))}
                      aria-expanded={isOpen}
                      aria-controls={`cat-body-${cat.categoryId}`}
                    >
                      {visibleFlags.length === 0 ? (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                          <circle cx="8" cy="8" r="7" stroke="#22c55e" strokeWidth="1.5" />
                          <path d="M5 8l2 2 4-4" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                          <circle cx="8" cy="8" r="7" stroke={scoreColor(cat.score)} strokeWidth="1.5" />
                          <path d="M8 5v3.5M8 10.5v.5" stroke={scoreColor(cat.score)} strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      )}
                      <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{cat.label}</span>
                      <span className={`badge sev-${cat.severity}`}>{cat.severity.toUpperCase()}</span>
                      <span style={{ color: scoreColor(cat.score), fontWeight: 800, fontSize: 15, minWidth: 20, textAlign: "right" }}>{cat.score}</span>
                      {visibleFlags.length > 0 && (
                        <span style={{ color: reviewedInCat === visibleFlags.length ? "#15803d" : "#9ca3af", fontSize: 12, flexShrink: 0 }}>
                          {reviewedInCat}/{visibleFlags.length}
                        </span>
                      )}
                      <svg
                        width="16" height="16" viewBox="0 0 16 16" fill="none"
                        aria-hidden="true"
                        style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.2s", flexShrink: 0 }}
                      >
                        <path d="M4 6l4 4 4-4" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>

                    <div
                      id={`cat-body-${cat.categoryId}`}
                      className={`collapsible${isOpen ? " open" : ""}`}
                    >
                      <div style={{ padding: "14px 4px 4px" }}>
                        <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 14px", lineHeight: 1.6 }}>{cat.summary}</p>

                        {visibleFlags.length === 0 ? (
                          <div style={{ color: "#15803d", fontSize: 13, padding: "8px 0", display: "flex", gap: 6, alignItems: "center" }}>
                            No clauses flagged in this category.
                          </div>
                        ) : (
                          visibleFlags.map((flag) => {
                            const decided = decisions[flag.flagId];
                            const isDecided = decided && decided.action !== "__cleared__";
                            const pending = pendingFlag[flag.flagId];
                            const ac = isDecided ? ACTION_COLORS[decided.action] : null;

                            return (
                              <div
                                key={flag.flagId}
                                className={`flag-card${isDecided ? ` decided decided-${decided.action}` : ""}`}
                              >
                                {/* Flag header */}
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af", flexShrink: 0 }}>
                                    {flag.flagId} · {flag.location}
                                  </span>
                                  {isDecided && (
                                    <span style={{
                                      fontSize: 11, padding: "3px 10px", borderRadius: 99, fontWeight: 700,
                                      background: ac!.bg, border: `1px solid ${ac!.border}`, color: ac!.color,
                                    }}>
                                      ✓ {ACTION_LABEL[decided.action] ?? decided.action}
                                    </span>
                                  )}
                                </div>

                                <blockquote>"{flag.excerpt}"</blockquote>

                                <p style={{ color: "#374151", fontSize: 14, lineHeight: 1.65, margin: "12px 0" }}>{flag.risk}</p>

                                <div className="redline-box">
                                  <div className="redline-label">✏ Suggested alternative language</div>
                                  {flag.suggestedRedline}
                                </div>

                                {!isDecided ? (
                                  <div style={{ marginTop: 16 }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 8 }}>Choose your decision:</div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                      {(["accept", "escalate", "redline"] as const).map((action) => (
                                        <button
                                          key={action}
                                          className={`btn-action${pending?.action === action ? ` sel-${action}` : ""}`}
                                          onClick={() => setPendingFlag((p) => ({
                                            ...p,
                                            [flag.flagId]: { action, note: p[flag.flagId]?.note ?? "", submitting: false },
                                          }))}
                                          aria-pressed={pending?.action === action}
                                          aria-label={ACTION_LABEL[action]}
                                        >
                                          {ACTION_LABEL[action]}
                                        </button>
                                      ))}
                                    </div>

                                    {pending?.action && (
                                      <div style={{ marginTop: 14, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "14px 16px" }}>
                                        <label htmlFor={`note-${flag.flagId}`} style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                                          Add a note (optional)
                                        </label>
                                        <textarea
                                          id={`note-${flag.flagId}`}
                                          style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", resize: "vertical", minHeight: 68, color: "#111827", background: "#fff" }}
                                          placeholder="Add context for the report…"
                                          value={pending.note}
                                          onChange={(e) => setPendingFlag((p) => ({
                                            ...p,
                                            [flag.flagId]: { ...p[flag.flagId]!, note: e.target.value },
                                          }))}
                                        />
                                        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                                          <button
                                            className="btn-primary"
                                            disabled={pending.submitting}
                                            onClick={() => submitDecision(flag.flagId)}
                                            aria-label={`Confirm ${ACTION_LABEL[pending.action]} decision`}
                                          >
                                            {pending.submitting ? "Saving…" : `Confirm: ${ACTION_LABEL[pending.action]}`}
                                          </button>
                                          <button
                                            className="btn-ghost"
                                            style={{ fontSize: 13 }}
                                            onClick={() => setPendingFlag((p) => ({ ...p, [flag.flagId]: null }))}
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="decision-locked">
                                    <span style={{ fontSize: 12, color: "#9ca3af" }}>
                                      Decided {new Date(decided.decidedAt).toLocaleString()}
                                      {decided.note ? ` — "${decided.note}"` : ""}
                                    </span>
                                    <button
                                      className="btn-ghost"
                                      style={{ fontSize: 12, minHeight: 32, padding: "4px 12px" }}
                                      onClick={() => clearDecision(flag.flagId)}
                                      aria-label={`Change decision (currently: ${ACTION_LABEL[decided.action] ?? decided.action})`}
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

            {/* Bottom CTA after reviewing all */}
            {totalFlags > 0 && allReviewed && (
              <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: "18px 20px", marginTop: 24, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, color: "#15803d", fontSize: 15 }}>✓ All flags reviewed</div>
                  <div style={{ color: "#166534", fontSize: 13, marginTop: 2 }}>You can now generate the final report.</div>
                </div>
                <button className="btn-primary" onClick={generateReport} style={{ background: "#16a34a" }}>
                  Generate Report
                </button>
              </div>
            )}
          </div>
        )}

        {/* ===== REPORT VIEW ===== */}
        {view === "report" && reportData && (
          <div>
            {/* Report action bar */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }} className="no-print">
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Final Report</h2>
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn-primary no-print" onClick={() => window.print()} aria-label="Print or save as PDF">
                  Print / Save PDF
                </button>
                <button className="btn-ghost no-print" onClick={() => setView("dashboard")}>
                  ← Back to Dashboard
                </button>
              </div>
            </div>

            {/* Report header (printed) */}
            <div style={{ borderBottom: "2px solid #111827", paddingBottom: 18, marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ fontWeight: 900, fontSize: 22, letterSpacing: "-0.02em" }}>ContractGuard</span>
                <span style={{ color: "#6b7280", fontSize: 14 }}>— Vendor Contract Risk Report</span>
              </div>
              <div style={{ color: "#6b7280", fontSize: 13, display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
                <span>Contract: <strong style={{ color: "#111827" }}>{reportData.filename}</strong></span>
                <span>Uploaded: {new Date(reportData.uploadedAt).toLocaleString()}</span>
                <span>Report generated: <strong style={{ color: "#111827" }}>{new Date(reportData.generatedAt).toLocaleString()}</strong></span>
              </div>
            </div>

            {reportData.truncated && (
              <div style={{ background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 8, padding: "10px 14px", color: "#92400e", marginBottom: 20, fontSize: 13 }}>
                ⚠ This contract was truncated at 50,000 characters. Clauses beyond that point were not reviewed.
              </div>
            )}

            {/* Overall score */}
            <div style={{ marginBottom: 28, display: "flex", alignItems: "flex-start", gap: 24, flexWrap: "wrap" }} className="print-section">
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Overall Risk Score</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 56, fontWeight: 900, color: scoreColor(reportData.analysis.overallRiskScore), lineHeight: 1 }}>
                    {reportData.analysis.overallRiskScore}
                  </span>
                  <span style={{ color: "#d1d5db", fontSize: 20 }}>/10</span>
                </div>
                <span className={`badge sev-${scoreSeverity(reportData.analysis.overallRiskScore)}`}>
                  {scoreSeverity(reportData.analysis.overallRiskScore).toUpperCase()} RISK
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Contract Summary</div>
                <p style={{ color: "#374151", lineHeight: 1.65, margin: 0, fontSize: 14 }}>{reportData.analysis.contractSummary}</p>
              </div>
            </div>

            {/* Category table */}
            <div style={{ marginBottom: 36 }} className="print-section">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, borderBottom: "1px solid #e5e7eb", paddingBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", color: "#374151" }}>
                Risk Summary by Category
              </h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f9fafb" }}>
                      <th style={{ textAlign: "left", padding: "9px 12px", border: "1px solid #e5e7eb", fontWeight: 700, color: "#374151" }}>Category</th>
                      <th style={{ textAlign: "center", padding: "9px 12px", border: "1px solid #e5e7eb", fontWeight: 700, color: "#374151", whiteSpace: "nowrap" }}>Score</th>
                      <th style={{ textAlign: "center", padding: "9px 12px", border: "1px solid #e5e7eb", fontWeight: 700, color: "#374151" }}>Severity</th>
                      <th style={{ textAlign: "left", padding: "9px 12px", border: "1px solid #e5e7eb", fontWeight: 700, color: "#374151" }}>Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.analysis.categories.map((cat) => (
                      <tr key={cat.categoryId} style={{ borderBottom: "1px solid #f3f4f6" }}>
                        <td style={{ padding: "9px 12px", border: "1px solid #e5e7eb", fontWeight: 600 }}>{cat.label}</td>
                        <td style={{ padding: "9px 12px", border: "1px solid #e5e7eb", textAlign: "center", fontWeight: 800, color: scoreColor(cat.score) }}>
                          {cat.score}/10
                        </td>
                        <td style={{ padding: "9px 12px", border: "1px solid #e5e7eb", textAlign: "center" }}>
                          <span className={`badge sev-${cat.severity}`}>{cat.severity.toUpperCase()}</span>
                        </td>
                        <td style={{ padding: "9px 12px", border: "1px solid #e5e7eb", color: "#6b7280", lineHeight: 1.5 }}>{cat.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Per-flag breakdown */}
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, borderBottom: "1px solid #e5e7eb", paddingBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", color: "#374151" }}>
                Flag-by-Flag Review &amp; Decisions
              </h3>
              {reportData.analysis.categories.flatMap((cat) =>
                cat.flags.filter((f) => f.excerpt).map((flag) => {
                  const dec = reportData.decisions[flag.flagId];
                  const isReal = dec && dec.action !== "__cleared__";
                  const ac = isReal ? ACTION_COLORS[dec.action] : null;
                  return (
                    <div key={flag.flagId} className="print-section" style={{ marginBottom: 24, paddingBottom: 24, borderBottom: "1px solid #f3f4f6" }}>
                      <div style={{ display: "flex", gap: 10, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>{cat.label}</span>
                        <span style={{ color: "#d1d5db" }}>·</span>
                        <span style={{ color: "#9ca3af", fontSize: 12 }}>{flag.flagId} · {flag.location}</span>
                        {isReal && (
                          <span style={{
                            marginLeft: "auto", fontSize: 11, padding: "3px 10px", borderRadius: 99, fontWeight: 700,
                            background: ac!.bg, border: `1px solid ${ac!.border}`, color: ac!.color,
                          }}>
                            {ACTION_LABEL[dec.action] ?? dec.action}
                          </span>
                        )}
                        {!isReal && (
                          <span style={{ marginLeft: "auto", fontSize: 11, padding: "3px 10px", borderRadius: 99, fontWeight: 700, background: "#f3f4f6", color: "#6b7280" }}>
                            No decision recorded
                          </span>
                        )}
                      </div>
                      <blockquote style={{ margin: "8px 0", fontSize: 12 }}>"{flag.excerpt}"</blockquote>
                      <p style={{ fontSize: 13, color: "#374151", lineHeight: 1.55, margin: "10px 0" }}>{flag.risk}</p>
                      {isReal && dec.note && (
                        <p style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic", margin: "6px 0 0", borderLeft: "2px solid #e5e7eb", paddingLeft: 10 }}>
                          Reviewer note: "{dec.note}"
                        </p>
                      )}
                    </div>
                  );
                })
              )}
              {reportData.analysis.categories.every((c) => c.flags.filter(f => f.excerpt).length === 0) && (
                <div style={{ color: "#15803d", fontSize: 14, padding: "16px 0", display: "flex", gap: 8 }}>
                  <span>✓</span>
                  <span>No risk flags were identified in this contract. All 10 categories reviewed with no clause-level concerns.</span>
                </div>
              )}
            </div>

            {/* Legal footer */}
            <div style={{ marginTop: 48, paddingTop: 20, borderTop: "2px solid #e5e7eb", fontSize: 12, color: "#6b7280", lineHeight: 1.7 }}>
              <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#374151" }}>Disclaimer</p>
              <p style={{ margin: 0 }}>
                This report was generated by ContractGuard on {new Date(reportData.generatedAt).toLocaleString()}.
                It does not constitute legal advice. All flag decisions above were made by a human reviewer.
                ContractGuard identifies potential risk signals only — consult a qualified attorney before signing any contract.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
