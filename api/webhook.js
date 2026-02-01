// api/webhook.js  (Vercel Serverless Function: /api/webhook)
// Production-grade webhook (NO canvas / NO PNG generation)
// - Validates Stripe signature
// - Updates Google Sheet state machine (idempotent-ish)
// - Returns 200 fast to avoid Stripe retries
// - Leaves heavy work (PNG/email) to a separate worker later

import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";

// IMPORTANT: Stripe webhook needs raw body
export const config = {
  api: { bodyParser: false },
};

// -------------------- Stripe --------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// -------------------- Google Sheets env --------------------
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// -------------------- Google Sheets helpers --------------------
function getSheetsClient() {
  if (!SA_JSON) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!SHEET_ID) throw new Error("Missing SHEET_ID");

  const creds = JSON.parse(SA_JSON);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

async function findRowIndexBySessionId(sheets, sessionId) {
  const range = `${SHEET_NAME}!A:A`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  const values = resp.data.values || [];
  for (let i = 1; i < values.length; i++) {
    if ((values[i]?.[0] || "").trim() === sessionId) return i + 1; // 1-based row
  }
  return null;
}

async function getStatusByRow(sheets, rowIndex) {
  const range = `${SHEET_NAME}!C${rowIndex}:C${rowIndex}`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return resp.data.values?.[0]?.[0] || "";
}

async function appendOrderRow(sheets, { sessionId, email, status, error = "" }) {
  const now = new Date().toISOString();
  const values = [[sessionId, email || "", status, now, now, error]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

async function updateOrderStatus(sheets, rowIndex, status, error = "") {
  const now = new Date().toISOString();

  // C = status
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!C${rowIndex}:C${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });

  // E = updated_at
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!E${rowIndex}:E${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[now]] },
  });

  // F = error
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!F${rowIndex}:F${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[error]] },
  });
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function pickEmail(session) {
  return (
    session.customer_details?.email ||
    session.customer_email ||
    session.customer_details?.phone || // fallback, not ideal
    ""
  );
}

// -------------------- Main handler --------------------
export default async function handler(req, res) {
  const BUILD = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  const reqId =
    req.headers["x-vercel-id"] ||
    req.headers["x-vercel-trace-id"] ||
    "unknown";

  // Always return JSON
  const reply = (code, body) => res.status(code).json({ build: BUILD, reqId, ...body });

  try {
    console.log("[webhook] start", { build: BUILD, reqId, method: req.method });

    if (req.method !== "POST") {
      return reply(405, { error: "Method Not Allowed" });
    }

    const sig = req.headers["stripe-signature"];
    if (!sig) {
      return reply(400, { error: "Missing stripe-signature" });
    }

    let event;
    try {
      const rawBody = await getRawBody(req);
      event = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[webhook] invalid signature", {
        build: BUILD,
        reqId,
        message: err?.message,
      });
      // Stripe expects 400 for signature issues (won't retry endlessly)
      return reply(400, { error: "Invalid signature" });
    }

    // We only need checkout.session.completed for the order pipeline
    if (event.type !== "checkout.session.completed") {
      console.log("[webhook] ignored event", { type: event.type });
      // Return 200 so Stripe doesn't retry
      return reply(200, { ignored: true, type: event.type });
    }

    const session = event.data.object;
    const sessionId = safeStr(session?.id);
    const email = pickEmail(session);
    const metadata = session?.metadata || {};

    if (!sessionId) {
      console.error("[webhook] missing sessionId", { build: BUILD, reqId });
      // Return 200 to avoid retry storms; log will show bug
      return reply(200, { received: true, skipped: true, reason: "missing_session_id" });
    }

    console.log("[webhook] hit", { build: BUILD, reqId, sessionId, email });
    console.log("[webhook] metadata", metadata);

    const sheets = getSheetsClient();

    // Idempotency behavior:
    // - If row doesn't exist: create with status=queued
    // - If row exists and already "delivered": do nothing (ack 200)
    // - Else: set status=queued again (safe to re-queue)
    let rowIndex = await findRowIndexBySessionId(sheets, sessionId);

    if (!rowIndex) {
      await appendOrderRow(sheets, {
        sessionId,
        email,
        status: "queued",
        error: "",
      });
      rowIndex = await findRowIndexBySessionId(sheets, sessionId);
      console.log("[webhook] row appended", { sessionId, rowIndex });
    } else {
      const status = await getStatusByRow(sheets, rowIndex);
      console.log("[webhook] existing row", { sessionId, rowIndex, status });

      if (String(status).toLowerCase() === "delivered") {
        // Already fulfilled: ACK fast
        return reply(200, { received: true, already_delivered: true });
      }

      await updateOrderStatus(sheets, rowIndex, "queued", "");
    }

    // NOTE: Heavy work intentionally removed:
    // - no canvas
    // - no blob upload
    // - no email send
    // A worker/cron can pick up rows with status=queued and process them.

    console.log("[webhook] queued", { sessionId, rowIndex });

    return reply(200, {
      received: true,
      queued: true,
      sessionId,
      rowIndex,
    });
  } catch (err) {
    console.error("[webhook] FATAL", {
      build: BUILD,
      reqId,
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
    });

    // In production, prefer returning 200 to avoid retry storms for non-signature failures.
    // But returning 500 can be useful during rollout. Choose your preference:
    // return reply(500, { error: err?.message || "unknown_fatal_error" });

    return reply(200, {
      received: true,
      queued: false,
      fatal: true,
      error: err?.message || "unknown_fatal_error",
    });
  }
}
