import Stripe from "stripe";
import getRawBody from "raw-body";
import { google } from "googleapis";
import { createCanvas } from "@napi-rs/canvas";
import { put } from "@vercel/blob";
import { Resend } from "resend";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});
const resend = new Resend(process.env.RESEND_API_KEY);


const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Orders";
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
  // 读 A 列：session_id
  const range = `${SHEET_NAME}!A:A`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  // values[0] 通常是表头
  for (let i = 1; i < values.length; i++) {
    if ((values[i]?.[0] || "").trim() === sessionId) {
      // Google Sheets 行号从 1 开始
      return i + 1;
    }
  }
  return null;
}

async function getStatusByRow(sheets, rowIndex) {
  // status 在 C 列
  const range = `${SHEET_NAME}!C${rowIndex}:C${rowIndex}`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  const status = resp.data.values?.[0]?.[0] || "";
  return status;
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
  // 更新 C(status)、E(updated_at)、F(error)
  const range = `${SHEET_NAME}!C${rowIndex}:F${rowIndex}`;
  const values = [[status, "", now, error]]; // D列占位不改，用空字符串写入会覆盖；所以我们只写 C/E/F 更安全
  // 为避免覆盖 D 列，这里改用分两次 update（更稳但多一次请求）
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

function generateNamePNG({ chineseName, englishName }) {
  const width = 2000;
  const height = 2000;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 背景白色（如果你要透明背景，把这三行删掉即可）
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // 中文名（大字）
  ctx.fillStyle = "#000000";
  ctx.font = "bold 200px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(chineseName || "—", width / 2, height / 2 - 40);

  // 英文名（小字）
  ctx.font = "60px sans-serif";
  ctx.fillText(englishName || "", width / 2, height / 2 + 120);

  // 返回 PNG Buffer（后面用于上传/邮件附件）
  return canvas.toBuffer("image/png");
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

  // 只处理你需要的事件
  if (event.type !== "checkout.session.completed") {
    res.status(200).json({ ignored: true });
    return;
  }

  const session = event.data.object;
  const sessionId = session.id;
  const email = session.customer_details?.email || session.customer_email || "";

  const sheets = getSheetsClient();

  // ---- 幂等核心：检查 session_id 是否已 delivered/processing ----
  const existingRow = await findRowIndexBySessionId(sheets, sessionId);

  if (existingRow) {
    const status = await getStatusByRow(sheets, existingRow);
    // delivered / processing 都直接吞掉，避免重复交付
    if (status === "delivered" || status === "processing") {
      res.status(200).json({ duplicate: true, status });
      return;
    }
    // failed 允许重试：继续往下走，把它改回 processing
    await updateOrderStatus(sheets, existingRow, "processing", "");
  } else {
    // 第一次见到：先落一行 processing（先占位）
    await appendOrderRow(sheets, { sessionId, email, status: "processing" });
  }

  // 重新定位行号（append 后行号会变化，稳妥做一次查找）
  const rowIndex = await findRowIndexBySessionId(sheets, sessionId);

  try {
    try {
  // 1) 从 metadata 取内容（确保你在 create-checkout-session.js 里有写入 metadata）
  const chineseName = session.metadata?.chinese_name || "—";
  const englishName = session.metadata?.english_name || "";

  // 2) 生成 PNG Buffer
  const pngBuffer = generateNamePNG({ chineseName, englishName });

  // 3) 上传到 Vercel Blob（返回公开 URL）
  const blob = await put(`orders/${session.id}.png`, pngBuffer, {
    access: "public",
    contentType: "image/png",
  });
  const downloadUrl = blob.url;

  // 4) 发送交付邮件（Resend）
  await resend.emails.send({
    from: "MyName World <deliver@yourdomain.com>",
    to: email,
    subject: "Your PNG is ready",
    html: `
      <p>Your file is ready.</p>
      <p><strong>Chinese name:</strong> ${chineseName}</p>
      <p><a href="${downloadUrl}" target="_blank">Download PNG</a></p>
    `,
  });

  // 5) 更新状态：delivered
  await updateOrderStatus(sheets, rowIndex, "delivered", "");

  res.status(200).json({ received: true, delivered: true, url: downloadUrl });
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

    // await deliver(session);

    await updateOrderStatus(sheets, rowIndex, "delivered", "");
    res.status(200).json({ received: true, delivered: true });
  } catch (err) {
    console.error("❌ Delivery failed:", err);
    await updateOrderStatus(
      sheets,
      rowIndex,
      "failed",
      err?.message || "unknown_error"
    );
    // Stripe 会重试 webhook，这正是我们要的
    res.status(500).json({ received: true, delivered: false });
  }
}
