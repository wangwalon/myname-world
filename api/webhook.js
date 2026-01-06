import Stripe from "stripe";
import { buffer } from "micro";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method Not Allowed");
  }

  let event;

  try {
    const rawBody = await buffer(req);
    const signature = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ 签名验证已通过
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("✅ checkout.session.completed", {
      id: session.id,
      amount_total: session.amount_total,
      email: session.customer_details?.email,
      metadata: session.metadata,
    });
  }

  res.status(200).json({ received: true });
}
