// /pages/api/webhook.js  (Next.js pages router)
// ✅ 中英文可见：内置加载字体（Noto Sans + Noto Sans SC）
// ✅ 最小可见 Debug：生成时打印日志 + 画红框 + DEBUG 文本
//
// 你需要做的只有两件事：
// 1) 把字体文件放到：/assets/fonts/ 目录（见下方文件名）
// 2) 确保 Vercel 环境变量：STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON / BLOB_READ_WRITE_TOKEN

import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { put } from "@vercel/blob";

export const config = {
  api: { bodyParser: false }, // Stripe webhook 必须关掉 bodyParser
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// -------------------- Font bootstrap (关键) --------------------
// 把字体文件放到项目：/assets/fonts/ 下
// 推荐文件名（你可用别的，但要同步改这里的路径）：
// - assets/fonts/NotoSans-Regular.ttf
// - assets/fonts/NotoSans-Bold.ttf
// - assets/fonts/NotoSansSC-Regular.ttf
// - assets/fonts/NotoSansSC-Bold.ttf
//
// 字体来源（任选）：Google Fonts 下载 Noto Sans / Noto Sans SC 的 ttf
// 注意：务必提交到 GitHub，让 Vercel 构建时能拿到文件。

let FONTS_READY = false;
function ensureFontsLoaded() {
  if (FONTS_READY) return;

  // 下面路径是“相对本文件”的路径：pages/api/webhook.js → ../../assets/fonts/xxx.ttf
  const ok1 = GlobalFonts.registerFromPath(
    "assets/fonts/NotoSans-Regular.ttf",
    "NotoSans"
  );
  const ok2 = GlobalFonts.registerFromPath(
    "assets/fonts/NotoSans-Bold.ttf",
    "NotoSansBold"
  );
  const ok3 = GlobalFonts.registerFromPath(
    "assets/fonts/NotoSansSC-Regular.ttf",
    "NotoSansSC"
  );
  const ok4 = GlobalFonts.registerFromPath(
    "assets/fonts/NotoSansSC-Bold.ttf",
    "NotoSansSCBold"
  );

  console.log("🧩 Fonts loaded:", { ok1, ok2, ok3, ok4 });
  console.log("🧩 Font families:", GlobalFonts.families);

  // 哪怕有一个失败，也先继续跑（你可以从日志里立刻看出）
  FONTS_READY = true;
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

// -------------------- PNG generator (中英文都可见) --------------------
function generateNamePNG({ chineseName, englishName }) {
  console.log("🔥 generateNamePNG CALLED");

  ensureFontsLoaded();

  const width = 2000;
  const height = 2000;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 背景白色
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // 红色边框（最小可见 debug）
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = 10;
  ctx.strokeRect(20, 20, width - 40, height - 40);

  // 永远画一行 DEBUG（必须可见）
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "bold 80px NotoSansBold";
  ctx.fillText("DEBUG: PNG GENERATED", width / 2, 60);

  const cn = (chineseName && chineseName.trim()) ? chineseName : "测试中文";
  const en = (englishName && englishName.trim()) ? englishName : "Test English";

  // 中文（用 NotoSansSCBold）
  ctx.textBaseline = "middle";
  ctx.font = "bold 220px NotoSansSCBold";
  ctx.fillText(cn, width / 2, height / 2 - 80);

  // 英文（用 NotoSansBold）
  ctx.font = "bold 110px NotoSansBold";
  ctx.fillText(en, width / 2, height / 2 + 180);

  const buf = canvas.toBuffer("image/png");
  console.log("✅ PNG generated bytes:", buf.length);
  return buf;
}

// -------------------- Main webhook handler --------------------
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

  const sheets = getSheetsClient();

  // ---- 幂等：检查是否已 delivered/processing ----
  const existingRow = await findRowIndexBySessionId(sheets, sessionId);

  if (existingRow) {
    const status = await getStatusByRow(sheets, existingRow);
    if (status === "delivered" || status === "processing") {
      return res.status(200).json({ duplicate: true, status });
    }
    await updateOrderStatus(sheets, existingRow, "processing", "");
  } else {
    await appendOrderRow(sheets, { sessionId, email, status: "processing" });
  }

  const rowIndex = await findRowIndexBySessionId(sheets, sessionId);

  try {
    // 1) 从 metadata 取名字（没有就默认）
    const chineseName = session.metadata?.chinese_name || "小明";
    const englishName = session.metadata?.english_name || "Michael";

    // 2) 生成 PNG
    const pngBuffer = generateNamePNG({ chineseName, englishName });

    // 3) 上传 Vercel Blob（public URL）
    const blob = await put(`orders/${sessionId}.png`, pngBuffer, {
      access: "public",
      contentType: "image/png",
    });

    console.log("✅ Blob URL:", blob.url);

    // 4) 更新状态
    await updateOrderStatus(sheets, rowIndex, "delivered", "");

    return res.status(200).json({
      received: true,
      delivered: true,
      pngUrl: blob.url,
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
