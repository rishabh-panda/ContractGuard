# ContractGuard — Vendor Contract Red-Flag Scanner

> AI-powered contract risk analysis for small and mid-sized teams who cannot afford legal review on every contract they sign.

ContractGuard accepts a PDF or plain-text contract, runs structured AI analysis across **10 legal risk categories**, and returns an interactive risk dashboard where each flagged clause requires a deliberate human decision before a final, print-ready report is generated.

This is not a summarizer. It is a **decision-forcing workflow tool**.

---

## Table of Contents

- [Demo Flow](#demo-flow)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Risk Categories](#risk-categories)
- [Architecture Decisions](#architecture-decisions)
- [Error Handling Matrix](#error-handling-matrix)
- [Known Limitations](#known-limitations)
- [Security Notes](#security-notes)
- [Legal Disclaimer](#legal-disclaimer)

---

## Demo Flow

```
Upload contract (PDF or .txt, up to 5 MB)
        │
        ▼
Extract raw text → sanitize → truncate at 50,000 chars if needed
        │
        ▼
Send to Claude claude-sonnet-4-6 with structured 10-category prompt
        │
        ▼
Parse JSON response → scores, severities, flagged clauses + redline suggestions
        │
        ▼
Render Risk Dashboard
  • Overall risk score (0–10) with severity badge
  • SVG bar chart — 10 categories, color-coded by score
  • Collapsible flag cards (clause excerpt, risk explanation, suggested redline)
        │
        ▼
Human reviews each flag → Accept Risk | Escalate to Counsel | Request Redline
  • Optional note per decision
  • Decisions synced to server in real time
  • "Change decision" re-opens the flag for re-review
        │
        ▼ (all flags actioned)
Generate & download Final Report (HTML, print-ready as PDF)
  • Full decision log with timestamps and reviewer notes
  • Legal disclaimer footer
  • Report generation timestamp distinct from upload timestamp
```

---

## Features

### Upload
- Drag-and-drop zone for `.pdf` and `.txt` files
- File picker fallback
- "Paste Text" toggle with a large textarea for direct contract input
- Client-side file size validation (5 MB) before hitting the server
- Selected file name displayed before analysis begins

### Processing
- Animated spinner with cycling status messages
- File name shown during processing so users know which contract is being analyzed
- **Cancel button** — abort in-flight analysis and return to upload
- Up to 2-minute timeout for long contracts

### Risk Dashboard
- **Overall risk score** (0–10) with color-coded severity badge derived directly from the score
- **Contract summary** paragraph from Claude
- **SVG risk matrix** — 10 horizontal bars, color-coded (green/amber/red/critical), clickable to jump to that category's flags
- **Banners** for truncation warnings and large-document notices
- **Progress tracker** — "X of Y flags reviewed" with animated progress bar
- **Generate Report** button — disabled until all flags are actioned, with remaining count shown below

### Flag Cards
- Quoted clause excerpt in monospace blockquote
- Location label (section or page reference)
- Plain-English risk explanation (2–3 sentences)
- Suggested alternative (redline) language in a distinct amber box
- Three decision buttons: **Accept Risk** | **Escalate to Counsel** | **Request Redline**
- Optional note textarea appears after selecting an action
- **Confirm** button shows the selected action for clarity
- Once confirmed: card locks with colored left border, decision badge, timestamp, and "Change decision" link
- Changing a decision syncs the removal to the server immediately

### Report
- Triggered only after all flags are reviewed (button is disabled otherwise)
- Separate report-generated timestamp (distinct from upload time)
- Full category risk table (score, severity badge, summary)
- Flag-by-flag breakdown with human decision, note, and suggested redline
- "No flags identified" message for clean contracts
- Professional legal disclaimer footer
- `window.print()` button — prints/saves as PDF with serif font and all sections expanded

### Session Resume
- Session ID stored in `localStorage`
- On page reload, attempts to resume from server — restores dashboard with existing decisions
- Falls back gracefully if session has expired

### Accessibility
- All interactive elements have `aria-label` or visible label text
- Collapsible sections have `aria-expanded` and `aria-controls`
- Focus rings visible (`outline: 2px solid #2563eb`)
- Color never used as the sole status indicator — paired with text badges and icons
- Toast notifications use `aria-live="polite"`

### Mobile
- Responsive layout at 480px breakpoint — all columns stack, full-width cards
- SVG chart scrolls horizontally on narrow viewports
- Minimum 44px touch targets on all interactive elements
- Sticky header for easy navigation
- Fixed "scroll to top" button on the dashboard

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite (TypeScript) |
| Backend | Express 5 (TypeScript, ESM) |
| AI | Anthropic Claude `claude-sonnet-4-6` via Replit AI Integrations |
| PDF Parsing | `pdf-parse` (CommonJS, loaded via `createRequire`) |
| File Upload | `multer` v2 (in-memory, no disk writes) |
| Session IDs | `uuid` v14 |
| Session Storage | In-memory `Map` (no database) |
| Monorepo | pnpm workspaces |
| Build | esbuild (API server bundle) |

> **No database. No user accounts. No external CDN dependencies in the frontend.**

---

## Project Structure

```
artifacts/
├── api-server/                    # Express API — all backend logic
│   └── src/
│       ├── app.ts                 # Express app setup (cors, json, pino)
│       ├── index.ts               # Server entry point, port binding
│       ├── lib/
│       │   ├── sessions.ts        # In-memory session Map + 30-min TTL purger
│       │   ├── extractor.ts       # PDF extraction (pdf-parse) + text extraction
│       │   └── analyzer.ts        # Claude API, chunking, merge, retry logic
│       └── routes/
│           ├── index.ts           # Router composition
│           ├── health.ts          # GET /api/healthz
│           └── contract.ts        # All ContractGuard API routes
│
└── contract-guard/                # React + Vite frontend
    └── src/
        ├── App.tsx                # Entire ContractGuard UI (all 4 views)
        ├── main.tsx               # React entry point
        └── index.css              # Minimal global reset
```

---

## Getting Started

### Prerequisites

- Node.js 20+ (LTS)
- pnpm 10+
- Replit AI Integrations configured (Anthropic) — or your own `ANTHROPIC_API_KEY`

### Install

```bash
pnpm install
```

### Development

The project runs as two separate services via pnpm workspace workflows:

```bash
# API server (port from $PORT env var, defaults to 8080)
pnpm --filter @workspace/api-server run dev

# Frontend (port from $PORT env var)
pnpm --filter @workspace/contract-guard run dev
```

A shared reverse proxy routes:
- `/api/*` → API server
- `/` → Frontend (contract-guard)

### Build (production)

```bash
pnpm --filter @workspace/api-server run build
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | Yes | Base URL for Anthropic API (auto-set by Replit AI Integrations) |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Yes | API key for Anthropic (auto-set by Replit AI Integrations) |
| `PORT` | No | Server port (default: 8080 for API, varies for frontend) |
| `SESSION_SECRET` | No | Available in secrets; reserved for future auth use |

> **Never hardcode API keys.** Both `AI_INTEGRATIONS_*` variables are automatically provisioned when you enable the Anthropic AI Integration in Replit. No manual key management needed.

The API server will throw on startup if either Anthropic variable is missing.

---

## API Reference

All routes are prefixed at `/api`.

### `GET /api/healthz`

Health check. Returns `{"status":"ok"}`.

---

### `POST /api/upload`

Upload a contract for text extraction.

**Multipart (file upload):**
```
Content-Type: multipart/form-data
Body: file (field name)
```

**Plain text (paste mode):**
```
Content-Type: text/plain
Body: raw contract text
```

**Accepted file types:** `application/pdf`, `text/plain`, `.pdf`, `.txt`  
**Max size:** 5 MB

**Success response:**
```json
{
  "sessionId": "uuid-v4",
  "filename": "contract.pdf",
  "charCount": 42000,
  "truncated": false
}
```

**Error responses:**
- `400` — No file received
- `413` — File exceeds 5 MB
- `415` — Unsupported file type
- `422` — Extraction failed (password-protected, scanned image, corrupt, empty)

---

### `POST /api/analyze`

Trigger Claude analysis for a session.

```json
{ "sessionId": "uuid-v4" }
```

Returns cached analysis if already computed for this session.

**Success response:**
```json
{
  "analysis": { ...AnalysisResult },
  "truncated": false,
  "largeDocument": false
}
```

**Error responses:**
- `400` — Missing sessionId
- `404` — Session expired
- `500` — Claude error or malformed response
- `504` — Analysis timed out (>120 seconds)

---

### `POST /api/decision`

Record a human decision for one flag.

```json
{
  "sessionId": "uuid-v4",
  "flagId": "AR_001",
  "action": "accept | escalate | redline | __cleared__",
  "note": "Optional reviewer note"
}
```

Use `action: "__cleared__"` to undo a previous decision.

**Success response:**
```json
{
  "ok": true,
  "decisions": {
    "AR_001": { "action": "accept", "note": "...", "decidedAt": 1700000000000 }
  }
}
```

---

### `GET /api/report/:sessionId`

Fetch the full session state for report generation.

**Success response:**
```json
{
  "sessionId": "uuid-v4",
  "filename": "contract.pdf",
  "uploadedAt": 1700000000000,
  "truncated": false,
  "analysis": { ...AnalysisResult },
  "decisions": { ...Record<flagId, Decision> }
}
```

---

### `DELETE /api/session/:sessionId`

Purge a session from memory immediately. Called automatically by the frontend when the user starts a new contract.

---

### Session Shape (server-side)

```typescript
{
  sessionId: string;         // UUID v4
  filename: string;          // Original filename
  rawText: string;           // Extracted + sanitized contract text
  charCount: number;         // Character count after sanitization
  uploadedAt: number;        // Unix timestamp (ms)
  truncated: boolean;        // true if text exceeded 50,000 chars
  analysis: AnalysisResult | null;
  decisions: Record<flagId, {
    action: string;          // accept | escalate | redline | __cleared__
    note: string;
    decidedAt: number;       // Unix timestamp (ms)
  }>;
}
```

---

## Risk Categories

Claude analyzes contracts across exactly **10 categories**:

| ID | Label | What it looks for |
|----|-------|-------------------|
| `AUTO_RENEWAL` | Auto-renewal | Automatic renewal terms, notice windows, evergreen clauses |
| `TERMINATION` | Termination | Termination for convenience, cure periods, termination fees |
| `LIABILITY_CAP` | Liability Cap | Limitation of liability, exclusions, damage caps vs contract value |
| `IP_OWNERSHIP` | IP Ownership | Work product ownership, IP assignment, license grants, moral rights |
| `DATA_RIGHTS` | Data Rights | Data usage, sharing, retention, GDPR/CCPA exposure |
| `INDEMNIFICATION` | Indemnification | Scope, mutual vs one-sided, defense obligations |
| `GOVERNING_LAW` | Governing Law | Jurisdiction, arbitration, class action waivers |
| `PAYMENT_TERMS` | Payment Terms | Late fees, price escalation, audit rights, FX risk |
| `CONFIDENTIALITY` | Confidentiality | NDA terms, carve-outs, survival period, permitted disclosures |
| `FORCE_MAJEURE` | Force Majeure | FM event scope, notice requirements, extended FM termination rights |

### Scoring

| Score | Severity | Color |
|-------|----------|-------|
| 0 | None | Green `#22c55e` |
| 1–3 | Low | Green `#22c55e` |
| 4–6 | Moderate | Amber `#f59e0b` |
| 7–8 | High | Red `#ef4444` |
| 9–10 | Critical | Dark Red `#dc2626` |

---

## Architecture Decisions

### Why in-memory sessions?

No database means no setup friction, no migration risk, and no PII stored at rest. Sessions expire after 30 minutes via a `setInterval` purger. This is appropriate for an analysis workflow where each session represents a single review cycle.

### Why chunk-and-merge for large contracts?

Claude has a context window limit. Contracts over 35,000 characters are split into overlapping chunks (2,000-char overlap) and analyzed independently. Results are merged by:
- Taking the **highest score** per category across chunks
- **Deduplicating flags** by excerpt substring similarity
- **Concatenating summaries** for context

### Why strip markdown fences from Claude's response?

Even with explicit instructions to return raw JSON, Claude sometimes wraps output in ` ```json ``` ` fences. The parser strips these before `JSON.parse` to prevent spurious failures.

### Why `createRequire` for pdf-parse?

The API server is an ES module package (`"type": "module"`). `pdf-parse` is CommonJS-only. Using `createRequire(import.meta.url)` loads it correctly without switching the entire package to CommonJS or maintaining a separate shim file.

### Why React + Vite for the frontend?

The monorepo scaffold uses Vite for all frontend artifacts. The ContractGuard UI is implemented as a single large React component with inline styles and no external UI library — matching the original spec's "vanilla HTML/CSS/JS" intent while benefiting from React's state management and Vite's HMR.

---

## Error Handling Matrix

| Scenario | HTTP | User-facing message |
|----------|------|---------------------|
| File > 5 MB (client-side) | — | Inline error, no server hit |
| File > 5 MB (server) | 413 | "File exceeds 5 MB limit." |
| Wrong file type | 415 | "Unsupported file type. Please upload a PDF (.pdf) or plain text (.txt) file." |
| Password-protected PDF | 422 | "PDF is password-protected. Please unlock it before uploading." |
| Scanned image PDF (no text layer) | 422 | "This PDF appears to be a scanned image with no text layer..." |
| Corrupt or malformed PDF | 422 | "Could not parse this PDF. Try saving it as a new PDF or uploading a .txt version." |
| Empty text file | 422 | "Uploaded file contains no readable text." |
| Contract truncated at 50k chars | — | Yellow banner on dashboard and report |
| Large document (>3 chunks) | — | Blue info banner on dashboard |
| Claude rate limit (429/529) | — | Retry once after 10s; then "Analysis service is busy — please try again in a minute." |
| Claude 500 error | 500 | "Analysis service error. Please try again." |
| Analysis timeout (>120s) | 504 | "Analysis timed out. Try uploading a shorter section of the contract." |
| Malformed JSON from Claude | 500 | "Analysis returned malformed data. Please try again." (raw output never exposed) |
| Fewer than 10 categories returned | 500 | Same as malformed JSON |
| Session expired (30-min TTL) | 404 | "Session expired. Please re-upload your contract." |
| Network failure during analysis | — | Retries up to 3 times (5s apart), then shows error with instruction to retry |
| User cancels analysis | — | Returns to upload view immediately, aborts in-flight fetch |
| Non-English contract (heuristic) | — | Info notice: "Best results on English-language contracts..." |
| Empty flag excerpt | — | Flag card skipped; server logs `WARN: empty excerpt in flagId` |

---

## Known Limitations

1. **Sessions are not persisted across server restarts.** All in-memory sessions are lost when the server process restarts. Users must re-upload their contract.

2. **50,000-character analysis limit.** Contracts exceeding 50,000 characters are truncated. Clauses beyond that point are not reviewed. A warning banner is shown.

3. **Scanned PDFs are not supported.** PDFs without a text layer (image-based scans) cannot be parsed. Use a text-based PDF or copy-paste the contract text instead.

4. **Analysis time varies.** Depending on contract length and Claude API load, analysis can take 30–120 seconds. Large documents analyzed in multiple chunks will take longer.

5. **English-language contracts only.** The AI prompt and risk scoring are tuned for English legal text. Non-English contracts may return reduced accuracy. A heuristic warning is displayed.

6. **No concurrent analysis protection.** If the same session is submitted to `/api/analyze` twice simultaneously, both requests will trigger a Claude API call. The second to complete will overwrite the first.

7. **No authentication.** ContractGuard has no user accounts, login, or access control. Do not use it to analyze contracts containing highly sensitive PII in a multi-tenant production environment without adding auth.

---

## Security Notes

- API keys are loaded exclusively from environment variables — never hardcoded or exposed to the client
- Raw Claude output is never forwarded to the frontend — only parsed, validated JSON is returned
- Session data lives in server memory only — no database writes, no filesystem writes
- Uploaded file buffers are processed in-memory via multer and never written to disk
- The frontend makes no external requests — all fetch calls go to the same-origin Express API

---

## Legal Disclaimer

ContractGuard is a risk signal identification tool. It does not provide legal advice. All flag decisions are made by a human reviewer. Consult a qualified attorney before signing any contract.

---

## License

Private. All rights reserved.
