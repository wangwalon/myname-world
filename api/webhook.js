import Stripe from 'stripe';

// ❗️必须关闭 bodyParser（Stripe Webhook 要原始 body）
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Stripe 已验证通过
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('✅ checkout.session.completed:', {
      id: session.id,
      email: session.customer_details?.email,
      amount: session.amount_total,
    });
  }

  res.status(200).json({ received: true });
}

// —— 工具函数（必须有）——
import { buffer } from 'micro';
