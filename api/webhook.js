import Stripe from "stripe";
import getRawBody from "raw-body";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

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
    const rawBody = await getRawBody(req); // ✅ 原始 Buffer

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    res.status(400).send("Invalid signature");
    return;
  }

  // ✅ 只在这里开始处理业务
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Payment confirmed:", session.id);

    // TODO:
    // 1. 幂等校验（session.id）
    // 2. 生成图片
    // 3. 发邮件
  }

  res.status(200).json({ received: true });
}
