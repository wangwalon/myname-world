// /pages/api/webhook.js  (Next.js pages router)
// 如果你用的是 app router 的 route.js，我也可以给对应版本；先按你当前 /api/webhook 的写法来。

import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { put } from "@vercel/blob";

export const config = {
  api: { bodyParser: false }, // Stripe webhook 必须关
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// ---------- Google Sheets ----------
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
    if ((values[i]?.[0] || "").trim() === sessionId) return i + 1;
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

// ---------- Fonts (must exist in repo) ----------
let fontsReady = false;
function ensureFontsLoaded() {
  if (fontsReady) return;

  // 你需要把字体文件放到：/public/fonts/
  // 文件名必须和这里一致（区分大小写）
  const ok1 = GlobalFonts.registerFromPath(
    process.cwd() + "/public/fonts/NotoSans-Regular.ttf",
    "NotoSans"
  );
  const ok2 = GlobalFonts.registerFromPath(
    process.cwd() + "/public/fonts/NotoSans-Bold.ttf",
    "NotoSansBold"
  );
  const ok3 = GlobalFonts.registerFromPath(
    process.cwd() + "/public/fonts/NotoSansSC-Regular.otf",
    "NotoSansSC"
  );
  const ok4 = GlobalFonts.registerFromPath(
    process.cwd() + "/public/fonts/NotoSansSC-Bold.otf",
    "NotoSansSCBold"
  );

  console.log("🧩 Fonts loaded:", { ok1, ok2, ok3, ok4 });
  console.log("🧩 Font families:", GlobalFonts.families);

  fontsReady = true;
}

// ---------- PNG generator ----------
function generateNamePNG({ chineseName, englishName }) {
  console.log("🔥 generateNamePNG CALLED");

  ensureFontsLoaded();

  const width = 2000;
  const height = 2000;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // white bg
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // red border (always visible)
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = 16;
  ctx.strokeRect(40, 40, width - 80, height - 80);

  // always-visible debug line (English)
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "bold 80px NotoSansBold, Arial, sans-serif";
  ctx.fillText("DEBUG: PNG GENERATED", width / 2, 80);

  const cn = (chineseName && chineseName.trim()) ? chineseName.trim() : "测试中文";
  const en = (englishName && englishName.trim()) ? englishName.trim() : "Test English";

  // English (must show)
  ctx.textBaseline = "middle";
  ctx.font = "bold 140px NotoSansBold, Arial, sans-serif";
  ctx.fillText(en, width / 2, height / 2 + 220);

  // Chinese (will show ONLY if SC font loaded)
  ctx.font = "bold 240px NotoSansSCBold, NotoSansSC, sans-serif";
  ctx.fillText(cn, width / 2, height / 2 - 80);

  const buf = canvas.toBuffer("image/png");
  console.log("✅ PNG generated bytes:", buf.length);

  return buf;
}

// ---------- Main webhook ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("Missing stripe-signature");

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err?.message);
    return res.status(400).send("Invalid signature");
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ ignored: true });
  }

  const session = event.data.object;
  const sessionId = session.id;
  const email = session.customer_details?.email || session.customer_email || "";

  console.log("🟦 webhook hit sessionId:", sessionId);
  console.log("🟦 metadata:", session.metadata || {});

  const sheets = getSheetsClient();

  // —— 仍然写表，但【调试阶段不再因为 delivered/duplicate 直接 return】——
  let rowIndex = await findRowIndexBySessionId(sheets, sessionId);
  if (!rowIndex) {
    await appendOrderRow(sheets, { sessionId, email, status: "processing" });
    rowIndex = await findRowIndexBySessionId(sheets, sessionId);
  } else {
    const status = await getStatusByRow(sheets, rowIndex);
    console.log("⚠️ existingRow status:", status, " (debug mode: will still generate)");
    await updateOrderStatus(sheets, rowIndex, "processing", "");
  }

  try {
    const chineseName = session.metadata?.chinese_name || "小明";
    const englishName = session.metadata?.english_name || "Michael";

    const pngBuffer = generateNamePNG({ chineseName, englishName });

    const blob = await put(`orders/${sessionId}.png`, pngBuffer, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: true, // 防止同名覆盖导致你一直打开旧图
    });

    console.log("✅ Blob URL:", blob.url);

    await updateOrderStatus(sheets, rowIndex, "delivered", "");

    return res.status(200).json({
      received: true,
      delivered: true,
      pngUrl: blob.url,
      note: "debug-mode: always generate",
    });
  } catch (err) {
    console.error("❌ Delivery failed:", err);
    await updateOrderStatus(
      sheets,
      rowIndex,
      "failed",
      err?.message || "unknown_error"
    );
    return res.status(500).json({ received: true, delivered: false });
  }
}
