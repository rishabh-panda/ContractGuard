# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM (not used by ContractGuard — in-memory sessions only)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

### ContractGuard (`artifacts/contract-guard`)
- **Kind**: react-vite (serves a single-page app at `/`)
- **Purpose**: Vendor Contract Red-Flag Scanner
- **Frontend**: React + Vite at `artifacts/contract-guard/src/App.tsx` — single large component, vanilla-style logic, no external UI libraries
- **Stack**: System font stack, inline CSS-in-style, pure SVG risk chart

### API Server (`artifacts/api-server`)
- **Kind**: Express API at `/api`
- **ContractGuard routes**:
  - `POST /api/upload` — accepts multipart (PDF/txt) or `text/plain` body; extracts text; returns `sessionId`
  - `POST /api/analyze` — calls Claude AI; returns 10-category risk analysis JSON
  - `POST /api/decision` — records human flag decision (accept/escalate/redline)
  - `GET /api/report/:sessionId` — returns full session state for report generation
  - `DELETE /api/session/:sessionId` — purges session from memory
- **Session storage**: In-memory `Map`, 30-minute TTL, purged every 5 minutes
- **AI**: Anthropic Claude via Replit AI Integrations (`AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`)
- **PDF parsing**: `pdf-parse` (CommonJS, loaded via `createRequire`)
- **File upload**: `multer` v2 (in-memory storage, 5 MB limit)

## Key Files

- `artifacts/api-server/src/lib/sessions.ts` — session Map + TTL purger
- `artifacts/api-server/src/lib/extractor.ts` — PDF + text extraction with error handling
- `artifacts/api-server/src/lib/analyzer.ts` — Claude API call, chunking, merge, retry logic
- `artifacts/api-server/src/routes/contract.ts` — all ContractGuard API routes
- `artifacts/contract-guard/src/App.tsx` — entire ContractGuard frontend (Upload → Processing → Dashboard → Report)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Known Limitations

- Sessions are lost on server restart (by design — in-memory only)
- Large contracts (>40k chars) are analyzed in overlapping chunks; flags are deduplicated by excerpt similarity
- Analysis can take 60–120 seconds depending on contract length and Claude response time

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
