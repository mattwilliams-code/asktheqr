const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    // Update the order status to 'paid'
    const { error } = await supabase
      .from('orders')
      .update({ status: 'paid' })
      .eq('stripe_session_id', session.id);

    if (error) {
      console.error('Supabase update error:', error);
      return { statusCode: 500, body: 'Database update failed' };
    }

    console.log(`Order paid: ${session.id} — ${session.customer_email}`);
  }

  return { statusCode: 200, body: 'ok' };
};
