import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";
import { createCanvas } from "@napi-rs/canvas";
import { put } from "@vercel/blob";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "orders_state";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// -------- Google Sheets helpers --------
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

// -------- PNG generator (ENGLISH ONLY VERIFY) --------
// -------- PNG generator (ENGLISH ONLY / DEBUG VERSION) --------
function generateNamePNG({ chineseName, englishName }) {
  console.log("🔥 generateNamePNG CALLED");

  const width = 2000;
  const height = 2000;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 1️⃣ 白色背景
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // 2️⃣ 红色边框（肉眼确认：不是空白图）
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = 12;
  ctx.strokeRect(40, 40, width - 80, height - 80);

  // 3️⃣ 顶部 Debug 文本（必定可见）
  ctx.fillStyle = "#000000";
  ctx.font = "bold 90px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("DEBUG PNG GENERATED", width / 2, 80);

  // 4️⃣ 只画英文（避免字体问题）
  const en = (englishName && englishName.trim()) ? englishName : "MICHAEL";

  ctx.font = "bold 260px Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(en, width / 2, height / 2);

  // 5️⃣ 返回 PNG
  const buffer = canvas.toBuffer("image/png");
  console.log("🔥 PNG size:", buffer.length);

  return buffer;
}

// -------- Main webhook handler --------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.status(400).send("Missing stripe-signature");
    return;
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
    console.error("❌ Webhook signature verification failed:", err?.message);
    res.status(400).send("Invalid signature");
    return;
  }

  if (event.type !== "checkout.session.completed") {
    res.status(200).json({ ignored: true });
    return;
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
      res.status(200).json({ duplicate: true, status });
      return;
    }
    await updateOrderStatus(sheets, existingRow, "processing", "");
  } else {
    await appendOrderRow(sheets, { sessionId, email, status: "processing" });
  }

  const rowIndex = await findRowIndexBySessionId(sheets, sessionId);

  try {
    // 只取英文（验证英文必显示）
    const englishName = session.metadata?.english_name || "Michael";

    // 生成英文 PNG
    const pngBuffer = generateNamePNG({ englishName });
    console.log("✅ PNG generated bytes:", pngBuffer.length);

    // 上传 Blob
    const blob = await put(`orders/${sessionId}.png`, pngBuffer, {
      access: "public",
      contentType: "image/png",
    });

    const pngUrl = blob.url;
    console.log("✅ Blob URL:", pngUrl);

    await updateOrderStatus(sheets, rowIndex, "delivered", "");

    res.status(200).json({ received: true, delivered: true, pngUrl });
  } catch (err) {
    console.error("❌ Delivery failed:", err);
    await updateOrderStatus(
      sheets,
      rowIndex,
      "failed",
      err?.message || "unknown_error"
    );
    res.status(500).json({ received: true, delivered: false });
  }
}
