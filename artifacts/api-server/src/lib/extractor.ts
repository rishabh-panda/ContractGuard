import { createRequire } from "module";
const require = createRequire(import.meta.url);

export interface ExtractionResult {
  text?: string;
  truncated?: boolean;
  error?: string;
}

const MAX_CHARS = 50000;

function sanitizeText(raw: string): { text: string; truncated: boolean } {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Collapse 3+ blank lines to 2
  text = text.replace(/\n{3,}/g, "\n\n");
  // Strip null bytes and non-printable characters except \t and \n
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  text = text.trim();

  let truncated = false;
  if (text.length > MAX_CHARS) {
    text =
      text.slice(0, MAX_CHARS) +
      "\n\n[TRUNCATED — document exceeds analysis limit. Clauses beyond this point were not reviewed.]";
    truncated = true;
  }

  return { text, truncated };
}

export async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);

    if (!data || data.text == null) {
      return { error: "Could not parse this PDF. Try saving it as a new PDF or uploading a .txt version." };
    }

    if (data.text.trim().length < 200) {
      return {
        error:
          "This PDF appears to be a scanned image with no text layer. Please upload a text-based PDF or paste the contract text directly.",
      };
    }

    const { text, truncated } = sanitizeText(data.text);
    return { text, truncated };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("password") || msg.toLowerCase().includes("encrypt")) {
      return { error: "PDF is password-protected. Please unlock it before uploading." };
    }
    return { error: "Could not parse this PDF. Try saving it as a new PDF or uploading a .txt version." };
  }
}

export function extractText(buffer: Buffer): ExtractionResult {
  const raw = buffer.toString("utf-8");
  if (!raw.trim()) {
    return { error: "Uploaded file contains no readable text." };
  }
  const { text, truncated } = sanitizeText(raw);
  return { text, truncated };
}
