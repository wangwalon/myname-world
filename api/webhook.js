// api/webhook.js  (Vercel Serverless Function: /api/webhook)
// ✅ Fonts in repo:
// - public/fonts/NotoSans_Condensed-Regular.ttf
// - public/fonts/NotoSans_Condensed-Bold.ttf
// - public/fonts/NotoSansSC-Regular.ttf
// - public/fonts/NotoSansSC-Bold.ttf

import fs from "fs";
import path from "path";

import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";

import canvasPkg from "@napi-rs/canvas";
const { createCanvas, registerFont } = canvasPkg;

import { put } from "@vercel/blob";

// IMPORTANT: Stripe webhook needs raw body
export const config = {
  api: {
    bodyParser: false,
  },
};

// -------------------- Stripe --------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// -------------------- Google Sheets env --------------------
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// -------------------- Fonts (from repo public/fonts) --------------------
const FONT_DIR = path.join(process.cwd(), "public", "fonts");

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
      console.error("[fonts] missing:", p);
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
  console.log("[fonts] registered from:", FONT_DIR);
  console.log("[fonts] files:", files);
}

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
  console.log("[png] generateNamePNG called");
  ensureFontsLoaded();

  const width = 2000;
  const height = 2000;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // background white
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // red border (debug)
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = 16;
  ctx.strokeRect(40, 40, width - 80, height - 80);

  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  // visible debug header
  ctx.font = "700 72px NotoSansEN, Arial, sans-serif";
  ctx.fillText("DEBUG: WEBHOOK PNG GENERATED", width / 2, 80);

  const cn =
    chineseName && chineseName.trim() ? chineseName.trim() : "测试中文";
  const en =
    englishName && englishName.trim() ? englishName.trim() : "Test English";

  // small debug info
  ctx.font = "400 44px NotoSansEN, Arial, sans-serif";
  ctx.fillText(`session: ${sessionId || "-"}`, width / 2, 170);

  // Chinese (big)
  ctx.textBaseline = "middle";
  ctx.font = "700 240px NotoSansSC, sans-serif";
  ctx.fillText(cn, width / 2, height / 2 - 80);

  // English (smaller)
  ctx.font = "700 120px NotoSansEN, Arial, sans-serif";
  ctx.fillText(en, width / 2, height / 2 + 180);

  const buf = canvas.toBuffer("image/png");
  console.log("[png] bytes:", buf.length, { cn, en });
  return buf;
}

// -------------------- Main handler --------------------
export default async function handler(req, res) {
  const BUILD = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  const reqId =
    req.headers["x-vercel-id"] ||
    req.headers["x-vercel-trace-id"] ||
    "unknown";

  try {
    console.log("[webhook] start", { build: BUILD, reqId, method: req.method });

    // Stripe webhook must be POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const sig = req.headers["stripe-signature"];
    if (!sig) {
      return res.status(400).json({ error: "Missing stripe-signature" });
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
      console.error("[webhook] signature verification failed", {
        build: BUILD,
        reqId,
        message: err?.message,
        stack: err?.stack,
      });
      return res.status(400).json({ error: "Invalid signature" });
    }

    // Only handle completed checkout
    if (event.type !== "checkout.session.completed") {
      console.log("[webhook] ignored event", { build: BUILD, reqId, type: event.type });
      return res.status(200).json({ ignored: true, type: event.type });
    }

    const session = event.data.object;
    const sessionId = session.id;
    const email =
      session.customer_details?.email || session.customer_email || "";

    console.log("[webhook] hit", { build: BUILD, reqId, sessionId, email });
    console.log("[webhook] metadata", session.metadata || {});

    // Extra visibility for font path on prod
    console.log("[webhook] FONT_DIR", FONT_DIR);
    console.log("[webhook] font files exist", {
      en_regular: fs.existsSync(path.join(FONT_DIR, "NotoSans_Condensed-Regular.ttf")),
      en_bold: fs.existsSync(path.join(FONT_DIR, "NotoSans_Condensed-Bold.ttf")),
      sc_regular: fs.existsSync(path.join(FONT_DIR, "NotoSansSC-Regular.ttf")),
      sc_bold: fs.existsSync(path.join(FONT_DIR, "NotoSansSC-Bold.ttf")),
    });

    const sheets = getSheetsClient();

    // Debug mode: always generate; still update status
    let rowIndex = await findRowIndexBySessionId(sheets, sessionId);
    if (!rowIndex) {
      await appendOrderRow(sheets, { sessionId, email, status: "processing" });
      rowIndex = await findRowIndexBySessionId(sheets, sessionId);
    } else {
      const status = await getStatusByRow(sheets, rowIndex);
      console.log("[webhook] existingRow", { sessionId, rowIndex, status });
      await updateOrderStatus(sheets, rowIndex, "processing", "");
    }

    // Delivery block (keep its own try so we can update sheet on failure)
    try {
      const chineseName = session.metadata?.chinese_name || "小明";
      const englishName = session.metadata?.english_name || "Michael";

      const pngBuffer = generateNamePNG({ chineseName, englishName, sessionId });

      const blob = await put(`orders/${sessionId}.png`, pngBuffer, {
        access: "public",
        contentType: "image/png",
        addRandomSuffix: true,
      });

      console.log("[webhook] blob url", { sessionId, url: blob.url });

      await updateOrderStatus(sheets, rowIndex, "delivered", "");

      console.log("[webhook] success", { build: BUILD, reqId, sessionId });
      return res.status(200).json({
        received: true,
        delivered: true,
        pngUrl: blob.url,
        build: BUILD,
      });
    } catch (err) {
      console.error("[webhook] delivery failed", {
        build: BUILD,
        reqId,
        sessionId,
        message: err?.message,
        name: err?.name,
        stack: err?.stack,
      });

      // try to write failure to sheet, but don't hide original error
      try {
        if (typeof rowIndex === "number") {
          await updateOrderStatus(
            sheets,
            rowIndex,
            "failed",
            err?.message || "unknown_error"
          );
        }
      } catch (sheetErr) {
        console.error("[webhook] failed to update sheet", {
          build: BUILD,
          reqId,
          sessionId,
          message: sheetErr?.message,
          stack: sheetErr?.stack,
        });
      }

      return res.status(500).json({
        received: true,
        delivered: false,
        error: err?.message || "unknown_error",
        build: BUILD,
      });
    }
  } catch (err) {
    console.error("[webhook] FATAL", {
      build: BUILD,
      reqId,
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
    });
    return res.status(500).json({
      error: err?.message || "unknown_fatal_error",
      build: BUILD,
      reqId,
    });
  }
}
