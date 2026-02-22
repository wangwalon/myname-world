import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  // From buy.html
  const {
    name_input,
    pref_gender = "neutral",
    pref_style = "modern",
    pref_length = "3",
    email, // optional: if you later add an email field
  } = req.body || {};

  const inputName = String(name_input || "").trim();
  if (!inputName) {
    return res.status(400).json({ error: "name_input is required" });
  }

  const gender = String(pref_gender || "neutral").trim();
  const style = String(pref_style || "modern").trim();
  const length = String(pref_length || "3").trim();

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],

      // If you don't collect email on your form, omit this.
      ...(email ? { customer_email: String(email).trim() } : {}),

      // This is the important part: persist user input + prefs
      metadata: {
        name_input: inputName,
        pref_gender: gender,
        pref_style: style,
        pref_length: length,
      },

      success_url:
        "https://myname-world-m7xd.vercel.app/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://myname-world-m7xd.vercel.app/buy.html",
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || "stripe_error" });
  }
}
