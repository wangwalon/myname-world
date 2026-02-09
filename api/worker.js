// api/worker.js
// Queue Worker: queued -> processing -> (render) -> (email) -> delivered/failed
//
// Required env:
// - SHEET_ID
// - SHEET_NAME (default "orders_state")
// - GOOGLE_SERVICE_ACCOUNT_JSON
// - RENDER_URL (your Cloud Run /render endpoint)
// - RENDER_AUTH (Bearer token for renderer)
// - RESEND_API_KEY
// - MAIL_FROM  (e.g. "MyName World <noreply@yourdomain.com>")
// Optional:
// - MAIL_REPLY_TO
// - CRON_SECRET (protect worker)

import { google } from "googleapis";
import { Resend } from "resend";

export const config = { api: { bodyParser: true } };

// -------------------- env --------------------
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const CRON_SECRET = process.env.CRON_SECRET;
const RENDER_URL = process.env.RENDER_URL || "";
const RENDER_AUTH = process.env.RENDER_AUTH || "";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || "";

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
  const requests = [];

  if (status != null) requests.push({ range: `${SHEET_NAME}!C${rowIndex}:C${rowIndex}`, values: [[status]] });
  if (updatedAt != null) requests.push({ range: `${SHEET_NAME}!E${rowIndex}:E${rowIndex}`, values: [[updatedAt]] });
  if (error != null) requests.push({ range: `${SHEET_NAME}!F${rowIndex}:F${rowIndex}`, values: [[error]] });
  if (pngUrl != null) requests.push({ range: `${SHEET_NAME}!G${rowIndex}:G${rowIndex}`, values: [[pngUrl]] });

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
  requireEnv("RENDER_URL", RENDER_URL);

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

async function sendDeliveryEmail({ to, sessionId, pngUrl }) {
  requireEnv("RESEND_API_KEY", RESEND_API_KEY);
  requireEnv("MAIL_FROM", MAIL_FROM);

  const resend = new Resend(RESEND_API_KEY);

  const subject = "Your file is ready";
  const text =
    `Your file is ready.\n\n` +
    `Order: ${sessionId}\n` +
    `Download: ${pngUrl}\n\n` +
    `If you have any questions, reply to this email.`;

  const html =
    `<p>Your file is ready.</p>` +
    `<p><b>Order:</b> ${sessionId}</p>` +
    `<p><b>Download:</b> <a href="${pngUrl}">${pngUrl}</a></p>`;

  const payload = {
    from: MAIL_FROM,
    to,
    subject,
    text,
    html,
    ...(MAIL_REPLY_TO ? { replyTo: MAIL_REPLY_TO } : {}),
  };

  const r = await resend.emails.send(payload);
  if (r?.error) throw new Error(`Email failed: ${r.error.message || "unknown_resend_error"}`);
}

// -------------------- main --------------------
export default async function handler(req, res) {
  const BUILD = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  const reqId = req.headers["x-vercel-id"] || req.headers["x-vercel-trace-id"] || "unknown";

  try {
    // auth (recommended)
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
      const sessionId = String(r[0] || "").trim();
      const email = String(r[1] || "").trim();
      const status = normStatus(r[2]);
      if (sessionId && email && status === "queued") queued.push({ rowIndex: i + 1, sessionId, email });
    }

    const picked = queued.slice(0, limit);

    if (picked.length === 0) {
      return json(res, 200, {
        build: BUILD,
        reqId,
        ok: true,
        processed: 0,
        failed: 0,
        rendererUsed: !!RENDER_URL,
        rendererUrlSafe: RENDER_URL ? String(RENDER_URL).replace(/\/+$/, "") : "",
        hasRendererAuth: !!RENDER_AUTH,
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
        rendererUsed: !!RENDER_URL,
        rendererUrlSafe: RENDER_URL ? String(RENDER_URL).replace(/\/+$/, "") : "",
        hasRendererAuth: !!RENDER_AUTH,
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

        const metadata = {}; // extend later if you want
        const pngUrl = await callRenderer({ sessionId, email, metadata });

        // send email (the missing final step)
        await sendDeliveryEmail({ to: email, sessionId, pngUrl });

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
        const msg = err?.message ? String(err.message).slice(0, 500) : "unknown_error";

        // If renderer succeeded but email failed, you still want pngUrl stored.
        // We can't guarantee pngUrl exists here, so only write error/status.
        try {
          await updateRowCells(sheets, rowIndex, {
            status: "failed",
            updatedAt: nowIso(),
            error: msg,
          });
        } catch (_) {}

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
      rendererUsed: !!RENDER_URL,
      rendererUrlSafe: RENDER_URL ? String(RENDER_URL).replace(/\/+$/, "") : "",
      hasRendererAuth: !!RENDER_AUTH,
      rendererAuthLen: (RENDER_AUTH || "").length,
    });
  } catch (err) {
    return json(res, 500, {
      build: BUILD,
      reqId,
      ok: false,
      error: err?.message || "fatal_worker_error",
    });
  }
}
