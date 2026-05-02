export interface SessionFlag {
  flagId: string;
  excerpt: string;
  location: string;
  risk: string;
  suggestedRedline: string;
}

export interface SessionCategory {
  categoryId: string;
  label: string;
  score: number;
  severity: string;
  summary: string;
  flags: SessionFlag[];
}

export interface AnalysisResult {
  analysisVersion: string;
  contractSummary: string;
  overallRiskScore: number;
  categories: SessionCategory[];
}

export interface Session {
  sessionId: string;
  filename: string;
  rawText: string;
  charCount: number;
  uploadedAt: number;
  truncated: boolean;
  analysis: AnalysisResult | null;
  decisions: Record<string, { action: string; note: string; decidedAt: number }>;
}

const sessions = new Map<string, Session>();

export function createSession(data: Omit<Session, 'decisions' | 'analysis'>): Session {
  const session: Session = { ...data, analysis: null, decisions: {} };
  sessions.set(data.sessionId, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function updateSession(sessionId: string, updates: Partial<Session>): void {
  const session = sessions.get(sessionId);
  if (session) {
    Object.assign(session, updates);
  }
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// Purge sessions older than 30 minutes
setInterval(() => {
  const now = Date.now();
  const ttl = 30 * 60 * 1000;
  for (const [id, session] of sessions.entries()) {
    if (now - session.uploadedAt > ttl) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);
