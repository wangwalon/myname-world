// api/worker.js
// Production Worker: processes status=queued rows and MUST render PNG via Cloud Run.
// Flow: queued -> processing -> delivered (with png_url) OR failed (with error)

import { google } from "googleapis";

export const config = { api: { bodyParser: true } };

// -------------------- env --------------------
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const CRON_SECRET = process.env.CRON_SECRET; // optional protect
const RENDER_URL = process.env.RENDER_URL || ""; // REQUIRED in prod
const RENDER_AUTH = process.env.RENDER_AUTH || ""; // recommended

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

async function updateRowCells(sheets, rowIndex, { status, updatedAt, error, pngUrl }) {
  const data = [];
  if (status != null) data.push({ range: `${SHEET_NAME}!C${rowIndex}:C${rowIndex}`, values: [[status]] });
  if (updatedAt != null) data.push({ range: `${SHEET_NAME}!E${rowIndex}:E${rowIndex}`, values: [[updatedAt]] });
  if (error != null) data.push({ range: `${SHEET_NAME}!F${rowIndex}:F${rowIndex}`, values: [[error]] });
  if (pngUrl != null) data.push({ range: `${SHEET_NAME}!G${rowIndex}:G${rowIndex}`, values: [[pngUrl]] });

  if (data.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
}

function redactUrl(u) {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "";
  }
}

async function callRenderer({ sessionId, email, metadata }) {
  // Production requirement: must have RENDER_URL
  requireEnv("RENDER_URL", RENDER_URL);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
    const resp = await fetch(RENDER_URL, {
      method: "POST",
      signal: controller.signal,
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

    const data = await resp.json().catch(() => ({}));
    const pngUrl = data?.pngUrl || "";
    if (!pngUrl) throw new Error("Renderer returned empty pngUrl");
    return pngUrl;
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("Renderer timeout (15s)");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- main --------------------
export default async function handler(req, res) {
  const BUILD = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  const reqId = req.headers["x-vercel-id"] || req.headers["x-vercel-trace-id"] || "unknown";

  try {
    // auth (optional)
    if (CRON_SECRET) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${CRON_SECRET}`) {
        return json(res, 401, { build: BUILD, reqId, ok: false, error: "Unauthorized" });
      }
    }

    const sheets = getSheetsClient();

    const limit = Math.max(1, Math.min(10, Number(req.query.limit || 3)));
    const dryRun = String(req.query.dry || "0") === "1";

    // Show renderer info without leaking secrets
    const rendererUsed = Boolean(RENDER_URL);
    const rendererUrlSafe = rendererUsed ? redactUrl(RENDER_URL) : "";

    console.log("[worker] start", {
      build: BUILD,
      reqId,
      limit,
      dryRun,
      rendererUsed,
      rendererUrlSafe,
      hasRendererAuth: Boolean(RENDER_AUTH),
    });

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
        rendererUsed,
        rendererUrlSafe,
      });
    }

    if (dryRun) {
      return json(res, 200, {
        build: BUILD,
        reqId,
        ok: true,
        dryRun: true,
        wouldProcess: picked,
        rendererUsed,
        rendererUrlSafe,
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
          pngUrl: "", // clear old value if any
        });

        // If you later store metadata in sheet, populate it here.
        const metadata = {};

        const pngUrl = await callRenderer({ sessionId, email, metadata });

        await updateRowCells(sheets, rowIndex, {
          status: "delivered",
          updatedAt: nowIso(),
          error: "",
          pngUrl,
        });

        processed++;
        results.push({ sessionId, rowIndex, ok: true, pngUrl });
        console.log("[worker] delivered", { sessionId, rowIndex, pngUrl });
      } catch (err) {
        failed++;
        const msg = err?.message ? String(err.message).slice(0, 500) : "unknown_error";

        try {
          await updateRowCells(sheets, rowIndex, {
            status: "failed",
            updatedAt: nowIso(),
            error: msg,
          });
        } catch (sheetErr) {
          console.error("[worker] sheet update failed", { sessionId, rowIndex, message: sheetErr?.message });
        }

        results.push({ sessionId, rowIndex, ok: false, error: msg });
        console.error("[worker] job failed", { sessionId, rowIndex, message: msg });
      }
    }

    return json(res, 200, {
      build: BUILD,
      reqId,
      ok: true,
      processed,
      failed,
      results,
      rendererUsed,
      rendererUrlSafe,
    });
  } catch (err) {
    console.error("[worker] FATAL", { message: err?.message, stack: err?.stack });
    return json(res, 500, { build: BUILD, reqId, ok: false, error: err?.message || "fatal_worker_error" });
  }
}
