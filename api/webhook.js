// api/webhook.js
// Stripe webhook -> enqueue Google Sheet row (status=queued)
// Idempotent on session_id
//
// Required env:
// - STRIPE_SECRET_KEY
// - STRIPE_WEBHOOK_SECRET
// - SHEET_ID
// - SHEET_NAME (default "orders_state")
// - GOOGLE_SERVICE_ACCOUNT_JSON

import Stripe from "stripe";
import { google } from "googleapis";

export const config = {
  api: {
    bodyParser: false, // IMPORTANT: Stripe needs raw body
  },
};

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

function requireEnv(name, v) {
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function nowIso() {
  return new Date().toISOString();
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
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

async function readAllRows(sheets) {
  const range = `${SHEET_NAME}!A:G`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return resp.data.values || [];
}

async function appendRow(sheets, values) {
  const range = `${SHEET_NAME}!A:G`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

function norm(s) {
  return String(s || "").trim();
}

export default async function handler(req, res) {
  try {
    requireEnv("STRIPE_SECRET_KEY", STRIPE_SECRET_KEY);
    requireEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    const rawBody = await readRawBody(req);
    const sig = req.headers["stripe-signature"];

    if (!sig) return res.status(400).json({ ok: false, error: "Missing stripe-signature" });

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      return res.status(400).json({ ok: false, error: `Invalid signature: ${e.message}` });
    }

    // Only handle successful checkout
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ ok: true, ignored: true, type: event.type });
    }

    const session = event.data.object;

    // Safety: only enqueue paid sessions
    const paymentStatus = norm(session.payment_status).toLowerCase();
    if (paymentStatus && paymentStatus !== "paid") {
      return res.status(200).json({ ok: true, ignored: true, reason: `payment_status=${paymentStatus}` });
    }

    const sessionId = norm(session.id);
    const email = norm(session.customer_details?.email || session.customer_email);

    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing session.id" });

    // ✅ CHANGED (line): avoid Stripe retries if email is missing
    if (!email) return res.status(200).json({ ok: true, ignored: true, reason: "Missing customer email", sessionId });

    const sheets = getSheetsClient();
    const rows = await readAllRows(sheets);

    // Header row assumed at index 0
    let existingRowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (norm(r[0]) === sessionId) {
        existingRowIndex = i + 1; // 1-based for Sheets
        break;
      }
    }

    if (existingRowIndex !== -1) {
      // Idempotent: already exists, do nothing
      return res.status(200).json({ ok: true, enqueued: false, sessionId, rowIndex: existingRowIndex });
    }

    const t = nowIso();
    // Columns:
    // A session_id | B email | C status | D created_at | E updated_at | F error | G png_url
    await appendRow(sheets, [sessionId, email, "queued", t, t, "", ""]);

    return res.status(200).json({ ok: true, enqueued: true, sessionId });
  } catch (e) {
    // ✅ CHANGED (line): avoid Stripe retries on transient failures
    return res.status(200).json({ ok: false, error: e?.message || "webhook_error" });
  }
}
