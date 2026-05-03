import { Router } from "express";
import multer, { type MulterError } from "multer";
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
    // Enforce 5MB limit for text body too
    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
    if (contentLength > 5 * 1024 * 1024) {
      res.status(413).json({ error: "Text content exceeds 5 MB limit." });
      return;
    }

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
      res.json({
        sessionId,
        filename: "pasted-contract.txt",
        charCount: result.text!.length,
        truncated: result.truncated ?? false,
      });
    });
    req.on("error", () => {
      res.status(400).json({ error: "Failed to read request body." });
    });
    return;
  }

  // Handle multipart file upload
  upload.single("file")(req, res, async (err) => {
    if (err) {
      const multerErr = err as MulterError;
      // Multer v2 may use .type or .code for the error kind
      const isFileSizeError =
        multerErr.code === "LIMIT_FILE_SIZE" ||
        (multerErr as unknown as { type?: string }).type === "LIMIT_FILE_SIZE";
      if (isFileSizeError) {
        res.status(413).json({ error: "File exceeds 5 MB limit. Please upload a smaller file." });
        return;
      }
      next(err);
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file received. Please select a file to upload." });
      return;
    }

    const { mimetype, originalname, buffer } = req.file;

    // Validate by MIME type AND file extension
    const lcName = originalname.toLowerCase();
    const validMime = mimetype === "application/pdf" || mimetype === "text/plain";
    const validExt = lcName.endsWith(".pdf") || lcName.endsWith(".txt");

    if (!validMime && !validExt) {
      res.status(415).json({ error: "Unsupported file type. Please upload a PDF (.pdf) or plain text (.txt) file." });
      return;
    }

    const isPdf = mimetype === "application/pdf" || lcName.endsWith(".pdf");
    let extraction;
    if (isPdf) {
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

  // Return cached analysis if already done
  if (session.analysis) {
    res.json({ analysis: session.analysis, truncated: session.truncated, largeDocument: false });
    return;
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("TIMEOUT")), 120000)
  );

  try {
    const analysisPromise = analyzeContract(session.rawText);
    const { result, error, largeDocument } = await Promise.race([
      analysisPromise,
      timeout,
    ]) as Awaited<ReturnType<typeof analyzeContract>>;

    if (error) {
      res.status(500).json({ error });
      return;
    }

    updateSession(sessionId, { analysis: result! });
    res.json({
      analysis: result!,
      truncated: session.truncated,
      largeDocument: largeDocument ?? false,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "TIMEOUT") {
      res.status(504).json({
        error: "Analysis timed out. Try uploading a shorter section of the contract.",
      });
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

  // Allow clearing a decision (action = "__cleared__")
  if (action === "__cleared__") {
    delete decisions[flagId];
  } else {
    decisions[flagId] = { action, note: note ?? "", decidedAt: Date.now() };
  }

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
