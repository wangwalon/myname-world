// api/webhook.js  (Vercel Serverless Function: /api/webhook)
//
// Expected fonts in repo:
// - public/fonts/NotoSans_Condensed-Regular.ttf
// - public/fonts/NotoSans_Condensed-Bold.ttf
// - public/fonts/NotoSansSC-Regular.ttf
// - public/fonts/NotoSansSC-Bold.ttf
//
// ENV required:
// - STRIPE_SECRET_KEY
// - STRIPE_WEBHOOK_SECRET
// - GOOGLE_SERVICE_ACCOUNT_JSON   (full JSON string)
// - SHEET_ID
// Optional:
// - SHEET_NAME (default: orders_state)
//
// Notes:
// - This file is ESM (package.json has "type": "module")

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";
import { createCanvas, registerFont } from "@napi-rs/canvas";
import { put } from "@vercel/blob";

// -------------------- Stripe --------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = new Stripe(STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
});

// -------------------- Google Sheets env --------------------
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// -------------------- Fonts (single declaration ONLY) --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONT_DIR = path.join(__dirname, "..", "public", "fonts");

let fontsReady = false;

function ensureFontsLoaded() {
  if (fontsReady) return;

  const files = [
    "NotoSans_Condensed-Regular.ttf",
    "NotoSans_Condensed-Bold.ttf",
    "NotoSansSC-Regular.ttf",
    "NotoSansSC-Bold.ttf",
  ];

  for (const f of files) {
    const p = path.join(FONT_DIR, f);
    if (!fs.existsSync(p)) {
      console.error("❌ Font missing:", p);
      throw new Error(`Font missing: ${f} (expected in /public/fonts)`);
    }
  }

  registerFont(path.join(FONT_DIR, "NotoSans_Condensed-Regular.ttf"), {
    family: "NotoSansEN",
    weight: "400",
  });
  registerFont(path.join(FONT_DIR, "NotoSans_Condensed-Bold.ttf"), {
    family: "NotoSansEN",
    weight: "700",
  });

  registerFont(path.join(FONT_DIR, "NotoSansSC-Regular.ttf"), {
    family: "NotoSansSC",
    weight: "400",
  });
  registerFont(path.join(FONT_DIR, "NotoSansSC-Bold.ttf"), {
    family: "NotoSansSC",
    weight: "700",
  });

  fontsReady = true;
  console.log("✅ Fonts registered from:", FONT_DIR);
}

// -------------------- Google Sheets helpers --------------------
function getSheetsClient() {
  if (!SA_JSON) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!SHEET_ID) throw new Error("Missing SHEET_ID");

  const creds = JSON.parse(SA_JSON);

  // Some env setups escape newlines in private_key; normalize.
  const privateKey =
    typeof creds.private_key === "string"
      ? creds.private_key.replace(/\\n/g, "\n")
      : creds.private_key;

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    privateKey,
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

  // assume row 1 is header
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

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!C${rowIndex}:C${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!E${rowIndex}:E${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[now]] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!F${rowIndex}:F${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[error]] },
  });
}

// -------------------- PNG generator --------------------
function generateNamePNG({ chineseName, englishName, sessionId }) {
  ensureFontsLoaded();

  const width = 2000;
  const height = 2000;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // debug border
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = 16;
  ctx.strokeRect(40, 40, width - 80, height - 80);

  // header
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "700 72px NotoSansEN, Arial, sans-serif";
  ctx.fillText("DEBUG: WEBHOOK PNG GENERATED", width / 2, 80);

  // session line
  ctx.font = "400 44px NotoSansEN, Arial, sans-serif";
  ctx.fillText(`session: ${sessionId || "-"}`, width / 2, 170);

  const cn =
    chineseName && chineseName.trim() ? chineseName.trim() : "测试中文";
  const en =
    englishName && englishName.trim() ? englishName.trim() : "Test English";

  // Chinese
  ctx.textBaseline = "middle";
  ctx.font = "700 240px NotoSansSC, sans-serif";
  ctx.fillText(cn, width / 2, height / 2 - 80);

  // English
  ctx.font = "700 120px NotoSansEN, Arial, sans-serif";
  ctx.fillText(en, width / 2, height / 2 + 180);

  const buf = canvas.toBuffer("image/png");
  console.log("✅ PNG bytes:", buf.length, { cn, en });
  return buf;
}

// -------------------- Main handler --------------------
export default async function handler(req, res) {
  try {
    if (!STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    }
    if (!STRIPE_WEBHOOK_SECRET) {
      return res.status(500).json({ error: "Missing STRIPE_WEBHOOK_SECRET" });
    }

    // Stripe webhook must be POST
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("Missing stripe-signature");

    let event;
    try {
      // raw-body -> Buffer for Stripe signature verification
      const rawBody = await getRawBody(req, { encoding: null });
      event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("❌ Signature verification failed:", err?.message || err);
      return res.status(400).send("Invalid signature");
    }

    // Only handle completed checkout
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ ignored: true, type: event.type });
    }

    const session = event.data.object;
    const sessionId = session.id;
    const email =
      session.customer_details?.email || session.customer_email || "";

    console.log("🟦 webhook hit:", { sessionId, email });
    console.log("🟦 metadata:", session.metadata || {});

    const sheets = getSheetsClient();

    // Idempotency (production-safe): if already delivered -> return 200.
    let rowIndex = await findRowIndexBySessionId(sheets, sessionId);

    if (!rowIndex) {
      await appendOrderRow(sheets, { sessionId, email, status: "processing" });
      rowIndex = await findRowIndexBySessionId(sheets, sessionId);
    } else {
      const status = await getStatusByRow(sheets, rowIndex);
      if (String(status).toLowerCase() === "delivered") {
        return res.status(200).json({ received: true, delivered: true, note: "already delivered" });
      }
      await updateOrderStatus(sheets, rowIndex, "processing", "");
    }

    const chineseName = session.metadata?.chinese_name || "小明";
    const englishName = session.metadata?.english_name || "Michael";

    const pngBuffer = generateNamePNG({ chineseName, englishName, sessionId });

    const blob = await put(`orders/${sessionId}.png`, pngBuffer, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: true,
    });

    console.log("✅ Blob URL:", blob.url);

    await updateOrderStatus(sheets, rowIndex, "delivered", "");

    return res.status(200).json({
      received: true,
      delivered: true,
      pngUrl: blob.url,
    });
  } catch (err) {
    console.error("❌ webhook handler failed:", err);
    return res.status(500).json({ error: err?.message || "unknown_error" });
  }
}
