import Stripe from "stripe";
import getRawBody from "raw-body";

export const config = {
  api: { bodyParser: false },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const sig = req.headers["stripe-signature"];
  let rawBody;

  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("❌ Failed to read raw body:", err);
    return res.status(400).json({ error: "Invalid body" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ 到这里说明：Stripe 签名验证通过 + 你的 endpoint 被命中了
  console.log("✅ Webhook received:", event.type);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const payload = {
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
      customer_email:
        session.customer_details?.email || session.customer_email || null,
      metadata: session.metadata || {},
      payment_intent: session.payment_intent,
    };

    console.log("✅ checkout.session.completed payload:", payload);

    // TODO（升级③-B/③-C）：写入 DB / 触发生成中文名 / 发邮件
  }

  return res.status(200).json({ received: true });
}
