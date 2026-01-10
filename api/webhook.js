import { google } from "googleapis";

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let event;
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

  try {
    event = req.body; // 直接用 JSON body
  } catch (err) {
    console.error("❌ Invalid body", err);
    return res.status(400).send("Invalid payload");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("✅ checkout.session.completed", {
      id: session.id,
      email: session.customer_details?.email,
      amount: session.amount_total,
      metadata: session.metadata,
    });
  }

  res.status(200).json({ received: true });
}
