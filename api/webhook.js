import Stripe from "stripe";

// ❗ 关键：关闭 bodyParser
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 从 request 里读取 raw body
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let event;

  try {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ 到这里说明签名已通过
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("✅ checkout.session.completed", {
      id: session.id,
      amount_total: session.amount_total,
      customer_email: session.customer_details?.email,
      metadata: session.metadata,
    });

    // TODO: 后续写 DB / 发邮件 / 触发履约
  }

  res.status(200).json({ received: true });
}
