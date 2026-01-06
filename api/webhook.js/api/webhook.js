// redeploy to reload env vars

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 读取原始 body（Webhook 验签必须用 raw body）
async function getRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

export default async function handler(req, res) {
  // 给你一个“可访问”信号，避免 Stripe / 浏览器误判 404
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/webhook" });
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).json({ error: "Missing stripe-signature header" });
  }

  let event;

  try {
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET // 这里填 whsec_...（放在 Vercel 环境变量）
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 验签通过，开始处理事件
  try {
    console.log("✅ Stripe event received:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // 你需要的关键字段（后续可写入数据库/发邮件/触发翻译等）
      const payload = {
        id: session.id,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_email: session.customer_details?.email || session.customer_email,
        metadata: session.metadata || {},
        payment_intent: session.payment_intent,
      };

      console.log("✅ checkout.session.completed payload:", payload);

      // TODO（升级③-B/③-C 会做）：
      // 1) 把 payload 写入 DB（Supabase/Sheets/Redis 都行）
      // 2) 触发你的“生成中文名”流程
      // 3) 发邮件通知用户
    }

    // 也可以监听 payment_intent.succeeded（你 Stripe 那边已选了）
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      console.log("✅ payment_intent.succeeded:", {
        id: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        receipt_email: pi.receipt_email,
        metadata: pi.metadata,
      });
    }

    // 必须回 200 告诉 Stripe “我收到了”
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err?.message);
    // 注意：这里返回 500，Stripe 会重试
    return res.status(500).json({ error: "Webhook handler failed" });
  }
}
