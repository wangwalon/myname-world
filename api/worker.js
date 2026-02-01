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

const CRON_SECRET = process.env.CRON_SECRET; // set in Vercel env
const RENDER_URL = process.env.RENDER_URL || ""; // optional external renderer
const RENDER_AUTH = process.env.RENDER_AUTH || ""; // optional auth for renderer

// Columns (current)
// A sessionId | B email | C status | D created_at | E updated_at | F error
// Optional:
// G png_url

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
  // Read A:G so we can optionally store png_url
  const range = `${SHEET_NAME}!A:G`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return resp.data.values || [];
}

async function updateRowCells(sheets, rowIndex, { status, updatedAt, error, pngUrl }) {
  // Update C (status), E (updated_at), F (error), optional G (png_url)
  const requests = [];

  if (status != null) {
    requests.push({
      range: `${SHEET_NAME}!C${rowIndex}:C${rowIndex}`,
      values: [[status]],
    });
  }
  if (updatedAt != null) {
    requests.push({
      range: `${SHEET_NAME}!E${rowIndex}:E${rowIndex}`,
      values: [[updatedAt]],
    });
  }
  if (error != null) {
    requests.push({
      range: `${SHEET_NAME}!F${rowIndex}:F${rowIndex}`,
      values: [[error]],
    });
  }
  if (pngUrl != null) {
    requests.push({
      range: `${SHEET_NAME}!G${rowIndex}:G${rowIndex}`,
      values: [[pngUrl]],
    });
  }

  if (requests.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: requests.map((r) => ({ range: r.range, values: r.values })),
    },
  });
}

async function callRenderer({ sessionId, email, metadata }) {
  // Optional external renderer: expects JSON { pngUrl: "https://..." }
  // If RENDER_URL not set, we just return empty string.
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
  const pngUrl = data?.pngUrl || "";
  if (!pngUrl) throw new Error("Renderer returned empty pngUrl");
  return pngUrl;
}

// -------------------- main --------------------
export default async function handler(req, res) {
  const BUILD = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  const reqId =
    req.headers["x-vercel-id"] ||
    req.headers["x-vercel-trace-id"] ||
    "unknown";

  try {
    // auth
    if (CRON_SECRET) {
      const auth = req.headers.authorization || "";
      const ok = auth === `Bearer ${CRON_SECRET}`;
      if (!ok) {
        return json(res, 401, { build: BUILD, reqId, error: "Unauthorized" });
      }
    }

    const sheets = getSheetsClient();

    // params
    const limit = Math.max(1, Math.min(10, Number(req.query.limit || 3))); // default 3, max 10
    const dryRun = String(req.query.dry || "0") === "1";

    console.log("[worker] start", { build: BUILD, reqId, limit, dryRun });

    const rows = await readAllRows(sheets);

    // Header row assumed at index 0
    const queued = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const sessionId = (r[0] || "").trim();
      const email = (r[1] || "").trim();
      const status = normStatus(r[2]);
      // optional metadata columns not stored here; use sessionId to fetch elsewhere if needed
      if (sessionId && status === "queued") {
        queued.push({ rowIndex: i + 1, sessionId, email });
      }
    }

    const picked = queued.slice(0, limit);

    if (picked.length === 0) {
      console.log("[worker] no queued rows");
      return json(res, 200, { build: BUILD, reqId, ok: true, processed: 0, failed: 0 });
    }

    if (dryRun) {
      return json(res, 200, {
        build: BUILD,
        reqId,
        ok: true,
        dryRun: true,
        wouldProcess: picked,
      });
    }

    let processed = 0;
    let failed = 0;
    const results = [];

    for (const job of picked) {
      const { rowIndex, sessionId, email } = job;
      const startedAt = nowIso();

      try {
        // mark processing first (best-effort lock)
        await updateRowCells(sheets, rowIndex, {
          status: "processing",
          updatedAt: startedAt,
          error: "",
        });

        // metadata is not stored in sheet currently; keep empty or extend later
        const metadata = {};

        const pngUrl = await callRenderer({ sessionId, email, metadata });

        await updateRowCells(sheets, rowIndex, {
          status: "delivered",
          updatedAt: nowIso(),
          error: "",
          // only write png_url if we have one (keeps sheet clean)
          ...(pngUrl ? { pngUrl } : {}),
        });

        processed++;
        results.push({ sessionId, rowIndex, ok: true, pngUrl: pngUrl || "" });
        console.log("[worker] delivered", { sessionId, rowIndex, pngUrl: pngUrl || "(none)" });
      } catch (err) {
        failed++;
        const msg = err?.message ? String(err.message).slice(0, 500) : "unknown_error";

        // mark failed
        try {
          await updateRowCells(sheets, rowIndex, {
            status: "failed",
            updatedAt: nowIso(),
            error: msg,
          });
        } catch (sheetErr) {
          console.error("[worker] failed to update sheet", {
            sessionId,
            rowIndex,
            message: sheetErr?.message,
          });
        }

        results.push({ sessionId, rowIndex, ok: false, error: msg });
        console.error("[worker] job failed", { sessionId, rowIndex, message: msg });
      }
    }

    console.log("[worker] done", { processed, failed });

    return json(res, 200, {
      build: BUILD,
      reqId,
      ok: true,
      processed,
      failed,
      results,
    });
  } catch (err) {
    console.error("[worker] FATAL", {
      message: err?.message,
      stack: err?.stack,
    });
    return json(res, 500, {
      build: BUILD,
      reqId,
      ok: false,
      error: err?.message || "fatal_worker_error",
    });
  }
}

