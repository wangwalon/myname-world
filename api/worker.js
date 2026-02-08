// api/worker.js
// Queue Worker (NO canvas). Processes Google Sheet rows with status=queued.
// Flow: queued -> processing -> delivered/failed
//
// Optional: if you set RENDER_URL, this worker will call it to get { pngUrl }.
// Security: protect with CRON_SECRET (Bearer token).

import { google } from "googleapis";

export const config = {
  api: { bodyParser: true },
};

// -------------------- env --------------------
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const CRON_SECRET = process.env.CRON_SECRET; // optional
const RENDER_URL = process.env.RENDER_URL || "";
const RENDER_AUTH = process.env.RENDER_AUTH || "";

// Columns:
// A sessionId | B email | C status | D created_at | E updated_at | F error | G png_url

// -------------------- helpers --------------------
function json(res, code, body) {
  return res.status(code).json(body);
}

function requireEnv(name, v) {
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function getSheetsClient() {
  requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON", SA_JSON);
  requireEnv("SHEET_ID", SHEET_ID);

  const creds = JSON.parse(SA_JSON);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

function nowIso() {
  return new Date().toISOString();
}

function normStatus(s) {
  return String(s || "").trim().toLowerCase();
}

async function readAllRows(sheets) {
  const range = `${SHEET_NAME}!A:G`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return resp.data.values || [];
}

async function updateRowCells(
  sheets,
  rowIndex,
  { status, updatedAt, error, pngUrl }
) {
  const data = [];

  if (status != null)
    data.push({ range: `${SHEET_NAME}!C${rowIndex}`, values: [[status]] });
  if (updatedAt != null)
    data.push({ range: `${SHEET_NAME}!E${rowIndex}`, values: [[updatedAt]] });
  if (error != null)
    data.push({ range: `${SHEET_NAME}!F${rowIndex}`, values: [[error]] });
  if (pngUrl != null)
    data.push({ range: `${SHEET_NAME}!G${rowIndex}`, values: [[pngUrl]] });

  if (!data.length) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
}

async function callRenderer({ sessionId, email, metadata }) {
  if (!RENDER_URL) return "";

  const resp = await fetch(RENDER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(RENDER_AUTH ? { authorization: `Bearer ${RENDER_AUTH}` } : {}),
    },
    body: JSON.stringify({ sessionId, email, metadata }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Renderer failed (${resp.status}): ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  if (!data?.pngUrl) throw new Error("Renderer returned empty pngUrl");
  return data.pngUrl;
}

// -------------------- main --------------------
export default async function handler(req, res) {
  const BUILD = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  const reqId =
    req.headers["x-vercel-id"] ||
    req.headers["x-vercel-trace-id"] ||
    "unknown";

  try {
    if (CRON_SECRET) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${CRON_SECRET}`) {
        return json(res, 401, { build: BUILD, reqId, error: "Unauthorized" });
      }
    }

    const sheets = getSheetsClient();
    const limit = Math.max(1, Math.min(10, Number(req.query.limit || 3)));
    const dryRun = String(req.query.dry || "0") === "1";

    const rows = await readAllRows(sheets);

    const queued = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const sessionId = (r[0] || "").trim();
      const email = (r[1] || "").trim();
      const status = normStatus(r[2]);
      if (sessionId && status === "queued") {
        queued.push({ rowIndex: i + 1, sessionId, email });
      }
    }

    const picked = queued.slice(0, limit);

    if (picked.length === 0) {
      return json(res, 200, {
        build: BUILD,
        reqId,
        ok: true,
        processed: 0,
        failed: 0,
        rendererUsed: Boolean(RENDER_URL),
        rendererUrlSafe: RENDER_URL || "",
        // ★ DEBUG（新增）
        hasRendererAuth: Boolean(RENDER_AUTH),
        rendererAuthLen: (RENDER_AUTH || "").length,
      });
    }

    if (dryRun) {
      return json(res, 200, {
        build: BUILD,
        reqId,
        ok: true,
        dryRun: true,
        wouldProcess: picked,
        rendererUsed: Boolean(RENDER_URL),
        rendererUrlSafe: RENDER_URL || "",
        // ★ DEBUG（新增）
        hasRendererAuth: Boolean(RENDER_AUTH),
        rendererAuthLen: (RENDER_AUTH || "").length,
      });
    }

    let processed = 0;
    let failed = 0;
    const results = [];

    for (const job of picked) {
      const { rowIndex, sessionId, email } = job;
      try {
        await updateRowCells(sheets, rowIndex, {
          status: "processing",
          updatedAt: nowIso(),
          error: "",
        });

        const pngUrl = await callRenderer({
          sessionId,
          email,
          metadata: {},
        });

        await updateRowCells(sheets, rowIndex, {
          status: "delivered",
          updatedAt: nowIso(),
          error: "",
          pngUrl,
        });

        processed++;
        results.push({ sessionId, rowIndex, ok: true, pngUrl });
      } catch (err) {
        failed++;
        const msg = String(err?.message || "unknown_error").slice(0, 500);
        await updateRowCells(sheets, rowIndex, {
          status: "failed",
          updatedAt: nowIso(),
          error: msg,
        });
        results.push({ sessionId, rowIndex, ok: false, error: msg });
      }
    }

    return json(res, 200, {
      build: BUILD,
      reqId,
      ok: true,
      processed,
      failed,
      results,
      rendererUsed: Boolean(RENDER_URL),
      rendererUrlSafe: RENDER_URL || "",
      // ★ DEBUG（新增）
      hasRendererAuth: Boolean(RENDER_AUTH),
      rendererAuthLen: (RENDER_AUTH || "").length,
    });
  } catch (err) {
    return json(res, 500, {
      build: BUILD,
      reqId,
      ok: false,
      error: err?.message || "fatal_worker_error",
      // ★ DEBUG（新增）
      hasRendererAuth: Boolean(RENDER_AUTH),
      rendererAuthLen: (RENDER_AUTH || "").length,
    });
  }
}
