import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  const { name, email } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price: "price_1SlJ5cJZvnGAgczWGz3h9ens", // ← 换成你自己的 Price ID
          quantity: 1,
        },
      ],
      customer_email: email,
      metadata: {
        name: name,
      },
      success_url: "https://myname-world-m7xd.vercel.app/success.html",
      cancel_url: "https://myname-world-m7xd.vercel.app",
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
