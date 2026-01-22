// api/webhook.js  (Vercel Serverless Function: /api/webhook)
// ✅ 匹配你仓库字体：
// - public/fonts/NotoSans_Condensed-Regular.ttf
// - public/fonts/NotoSans_Condensed-Bold.ttf
// - public/fonts/NotoSansSC-Regular.ttf
// - public/fonts/NotoSansSC-Bold.ttf
// /pages/api/webhook.js  (Next.js pages router)

import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";
import { createCanvas, registerFont } from "@napi-rs/canvas";
import { put } from "@vercel/blob";

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

  // 1) 先检查文件是否真的存在（日志里一眼看穿“路径不对/没提交”）
  for (const f of files) {
    const p = path.join(FONT_DIR, f);
    if (!fs.existsSync(p)) {
      console.error("❌ Font missing:", p);
      throw new Error(`Font missing: ${f} (expected in /public/fonts)`);
    }
  }

  // 2) 注册字体（family 名称后面 canvas ctx.font 会用到）
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
  console.log("✅ Font files:", files);
}

// -------------------- Google Sheets helpers --------------------
// ---------------- Fonts (2.3.2) ----------------
const FONT_DIR = path.join(process.cwd(), "public", "fonts");
let fontsReady = false;

function ensureFontsRegistered() {
  if (fontsReady) return;

  // 你仓库里实际存在的文件名（区分大小写）
  // - 英文：NotoSans_Condensed-*.ttf
  // - 中文：NotoSansSC-*.ttf
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

  console.log("🔥 Fonts registered from:", FONT_DIR);
  fontsReady = true;
}

// ---------------- Google Sheets helpers ----------------
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
  ensureFontsLoaded();
// ---------------- PNG generator (2.3.3 + 2.3.4) ----------------
function generateNamePNG({ chineseName, englishName }) {
  console.log("🔥 generateNamePNG CALLED");
  ensureFontsRegistered();

  const width = 2000;
  const height = 2000;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // background
  // 背景白色
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // red border (debug)
  // 红色边框（最小可见 Debug）
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = 16;
  ctx.strokeRect(40, 40, width - 80, height - 80);

  // 永远可见的 debug 英文行（用已注册的英文族）
  // header debug
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "700 80px NotoSansEN";
  ctx.fillText("DEBUG: PNG GENERATED", width / 2, 80);
  ctx.font = "700 72px NotoSansEN, Arial, sans-serif";
  ctx.fillText("DEBUG: WEBHOOK PNG GENERATED", width / 2, 80);

  const cn =
    chineseName && chineseName.trim() ? chineseName.trim() : "测试中文";
  const en =
    englishName && englishName.trim() ? englishName.trim() : "Test English";
  // small debug info
  ctx.font = "400 44px NotoSansEN, Arial, sans-serif";
  ctx.fillText(`session: ${sessionId || "-"}`, width / 2, 170);

  const cn = (chineseName || "测试").trim();
  const en = (englishName || "Test").trim();

  // Chinese (big)
  // 中文（明确使用中文族）
  ctx.textBaseline = "middle";
  ctx.font = "700 220px NotoSansSC";
  ctx.font = "700 240px NotoSansSC, sans-serif";
  ctx.fillText(cn, width / 2, height / 2 - 80);

  // English (smaller)
  ctx.font = "700 120px NotoSansEN, Arial, sans-serif";
  ctx.fillText(en, width / 2, height / 2 + 180);

  // 英文（明确使用英文族）
  ctx.font = "700 100px NotoSansEN";
  ctx.fillText(en, width / 2, height / 2 + 180);

  const buf = canvas.toBuffer("image/png");
  console.log("✅ PNG bytes:", buf.length, { cn, en });
  console.log("✅ PNG generated bytes:", buf.length);
  return buf;
}

// ---------------- Main webhook ----------------
// -------------------- Main handler --------------------
export default async function handler(req, res) {
  // Stripe webhook must be POST
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

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
    console.error("❌ Signature verification failed:", err?.message);
    return res.status(400).send("Invalid signature");
  }

  // Only handle completed checkout
  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ ignored: true, type: event.type });
  }

  const session = event.data.object;
  const sessionId = session.id;
  const email = session.customer_details?.email || session.customer_email || "";

  console.log("🟦 webhook hit:", { sessionId, email });
  console.log("🟦 metadata:", session.metadata || {});

  const sheets = getSheetsClient();

  // --- Debug mode behavior:
  // ✅ 不因为已 delivered 就直接 return（避免你以为没执行）
  // —— 调试阶段：仍然写表，但不因为 delivered/duplicate 直接 return —— //
  let rowIndex = await findRowIndexBySessionId(sheets, sessionId);
  if (!rowIndex) {
    await appendOrderRow(sheets, { sessionId, email, status: "processing" });
    rowIndex = await findRowIndexBySessionId(sheets, sessionId);
  } else {
    const status = await getStatusByRow(sheets, rowIndex);
    console.log(
      "⚠️ existingRow status:",
      status,
      "(debug mode: will still generate)"
    );
    console.log("⚠️ existing row status:", status, "(debug: still generate)");
    await updateOrderStatus(sheets, rowIndex, "processing", "");
  }

  try {
    const chineseName = session.metadata?.chinese_name || "小明";
    const englishName = session.metadata?.english_name || "Michael";

    const pngBuffer = generateNamePNG({ chineseName, englishName, sessionId });

    // ✅ addRandomSuffix 防止同名缓存，确保你每次打开都是新图
    const blob = await put(`orders/${sessionId}.png`, pngBuffer, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: true,
      addRandomSuffix: true, // 防止同名覆盖导致一直打开旧图
    });

    console.log("✅ Blob URL:", blob.url);

    await updateOrderStatus(sheets, rowIndex, "delivered", "");

    return res.status(200).json({
      received: true,
      delivered: true,
      pngUrl: blob.url,
      note: "debug-mode: always generate; fonts from repo /public/fonts",
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
