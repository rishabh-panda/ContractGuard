import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { extractPdf, extractText } from "../lib/extractor.js";
import { analyzeContract } from "../lib/analyzer.js";
import { createSession, getSession, updateSession, deleteSession } from "../lib/sessions.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// POST /api/upload
router.post("/upload", (req, res, next) => {
  const contentType = req.headers["content-type"] ?? "";

  // Handle plain-text paste
  if (contentType.startsWith("text/plain")) {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      const buf = Buffer.from(body, "utf-8");
      const result = extractText(buf);
      if (result.error) {
        res.status(422).json({ error: result.error });
        return;
      }
      const sessionId = uuidv4();
      createSession({
        sessionId,
        filename: "pasted-contract.txt",
        rawText: result.text!,
        charCount: result.text!.length,
        uploadedAt: Date.now(),
        truncated: result.truncated ?? false,
      });
      res.json({ sessionId, filename: "pasted-contract.txt", charCount: result.text!.length, truncated: result.truncated ?? false });
    });
    return;
  }

  // Handle multipart file upload
  upload.single("file")(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File exceeds 5 MB limit." });
        return;
      }
      next(err);
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const { mimetype, originalname, buffer } = req.file;

    if (mimetype !== "application/pdf" && mimetype !== "text/plain") {
      res.status(415).json({ error: "Unsupported file type. Please upload a PDF or .txt file." });
      return;
    }

    let extraction;
    if (mimetype === "application/pdf") {
      extraction = await extractPdf(buffer);
    } else {
      extraction = extractText(buffer);
    }

    if (extraction.error) {
      res.status(422).json({ error: extraction.error });
      return;
    }

    const sessionId = uuidv4();
    createSession({
      sessionId,
      filename: originalname,
      rawText: extraction.text!,
      charCount: extraction.text!.length,
      uploadedAt: Date.now(),
      truncated: extraction.truncated ?? false,
    });

    res.json({
      sessionId,
      filename: originalname,
      charCount: extraction.text!.length,
      truncated: extraction.truncated ?? false,
    });
  });
});

// POST /api/analyze
router.post("/analyze", async (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required." });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session expired. Please re-upload your contract." });
    return;
  }

  if (session.analysis) {
    res.json({ analysis: session.analysis, truncated: session.truncated });
    return;
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("TIMEOUT")), 120000)
  );

  try {
    const analysisPromise = analyzeContract(session.rawText);
    const { result, error, largeDocument } = await Promise.race([analysisPromise, timeout]) as Awaited<ReturnType<typeof analyzeContract>>;

    if (error) {
      res.status(500).json({ error });
      return;
    }

    updateSession(sessionId, { analysis: result! });
    res.json({ analysis: result!, truncated: session.truncated, largeDocument: largeDocument ?? false });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "TIMEOUT") {
      res.status(504).json({ error: "Analysis timed out. Try uploading a shorter section of the contract." });
      return;
    }
    res.status(500).json({ error: "Analysis failed. Please try again." });
  }
});

// POST /api/decision
router.post("/decision", (req, res) => {
  const { sessionId, flagId, action, note } = req.body as {
    sessionId?: string;
    flagId?: string;
    action?: string;
    note?: string;
  };

  if (!sessionId || !flagId || !action) {
    res.status(400).json({ error: "sessionId, flagId, and action are required." });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session expired. Please re-upload your contract." });
    return;
  }

  const decisions = { ...session.decisions };
  decisions[flagId] = { action, note: note ?? "", decidedAt: Date.now() };
  updateSession(sessionId, { decisions });

  res.json({ ok: true, decisions });
});

// GET /api/report/:sessionId
router.get("/report/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session expired. Please re-upload your contract." });
    return;
  }
  res.json({
    sessionId: session.sessionId,
    filename: session.filename,
    uploadedAt: session.uploadedAt,
    truncated: session.truncated,
    analysis: session.analysis,
    decisions: session.decisions,
  });
});

// DELETE /api/session/:sessionId
router.delete("/session/:sessionId", (req, res) => {
  deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

export default router;
