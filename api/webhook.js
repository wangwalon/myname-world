import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY);
async function sendDeliveryEmail({
  to,
  chineseName,
  pinyin,
  meaning,
  downloadLink,
}) {
  if (!to) return;

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to,
    subject: "Your Chinese Name Is Ready",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height:1.6;">
        <p>Hello,</p>

        <p>Thank you for your order with <strong>My Name World</strong>.</p>

        <p>We’re excited to let you know that your personalized Chinese name is ready.</p>

        <hr />

        <p><strong>Your Custom Chinese Name</strong></p>
        <p>
          <strong>Name:</strong> ${chineseName}<br/>
          <strong>Pronunciation:</strong> ${pinyin}<br/>
          <strong>Meaning:</strong> ${meaning}
        </p>

        <p>
          <strong>Download your files:</strong><br/>
          <a href="${downloadLink}">${downloadLink}</a>
        </p>

        <p>If you have any questions, just reply to this email.</p>

        <p>
          Warm regards,<br/>
          <strong>My Name World</strong><br/>
          hello@mynameworld.com
        </p>
      </div>
    `,
  });
}

// api/webhook.js
import Stripe from "stripe";
import { google } from "googleapis";

/**
 * Env required on Vercel:
 * - STRIPE_SECRET_KEY
 * - GOOGLE_SHEET_ID
 * - GOOGLE_SERVICE_ACCOUNT_JSON   (the whole service account JSON as ONE line string)
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getServiceAccountCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing env: GOOGLE_SERVICE_ACCOUNT_JSON");

  // Some people paste JSON with escaped newlines or as plain JSON.
  // This handles both.
  let jsonString = raw;

  // If it looks like it's wrapped in quotes, keep as-is; JSON.parse will handle it.
  // If it contains \n sequences in private_key, normalize after parsing.
  const creds = JSON.parse(jsonString);

  // Fix private_key line breaks if needed
  if (creds.private_key && creds.private_key.includes("\\n")) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  return creds;
}

async function getSheetsClient() {
  const credentials = getServiceAccountCredentials();

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function appendOrderRow({ sheets, row }) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) throw new Error("Missing env: GOOGLE_SHEET_ID");

  // Orders tab must exist and be named exactly "Orders"
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Orders!A:I",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

export default async function handler(req, res) {
  // Stripe sends POST
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Parse event body (your current setup uses raw JSON body without signature verify)
  let event;
  try {
    event = req.body;
    if (!event || typeof event !== "object") {
      throw new Error("Empty or non-object body");
    }
  } catch (err) {
    console.error("❌ Invalid body:", err);
    return res.status(400).send("Invalid payload");
  }

  // Only process completed checkout
  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true, ignored: true });
  }

  const session = event.data?.object || {};
  const sessionId = session.id || "";
  const paymentIntent = session.payment_intent || "";
  const amountTotal = session.amount_total ?? "";
  const currency = session.currency || "";
  const email = session.customer_details?.email || session.customer_email || "";
  const name = session.metadata?.name || "";

  console.log("✅ checkout.session.completed", {
    id: sessionId,
    email,
    amount: amountTotal,
    currency,
    metadata: session.metadata,
  });

  // Build row matching your headers:
  // created_at | event_type | session_id | payment_intent | amount_total | currency | customer_email | name | raw_json
  const row = [
    new Date().toISOString(),
    event.type,
    sessionId,
    paymentIntent,
    amountTotal,
    currency,
    email,
    name,
    JSON.stringify({
      id: sessionId,
      payment_intent: paymentIntent,
      amount_total: amountTotal,
      currency,
      customer_email: email,
      name,
      metadata: session.metadata || {},
    }),
  ];

  try {
    const sheets = await getSheetsClient();
    await appendOrderRow({ sheets, row });
    console.log("✅ Sheet appended:", sessionId);
    return res.status(200).json({ received: true, sheet: "appended" });
  } catch (err) {
    // IMPORTANT: to avoid Stripe retry storms you can still return 200,
    // but log the error loudly. For fastest go-live, return 200 and fix.
    console.error("❌ Failed to append sheet:", err?.message || err, err);
    return res.status(200).json({ received: true, sheet: "failed_append" });
  }
}
