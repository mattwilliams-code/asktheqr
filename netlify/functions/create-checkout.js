const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const {
    productName, price, quantity,
    customerEmail, customerName,
    phone, address, labelName, notes,
    qrDetails,
  } = body;

  // QR landing-page details — default to {} so a missing object can't crash the insert.
  // Empty optional fields are stored as NULL rather than '' for cleaner data.
  const qr = qrDetails || {};
  const orNull = (v) => (v && String(v).trim() ? String(v).trim() : null);

  // ── Minimal server-side guard rails (front end validates too) ──
  if (!productName || !price || !customerEmail || !labelName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required order fields' }) };
  }

  try {
    // 1. Save a pending order to Supabase (full order, including QR details)
    const { data: order, error: dbError } = await supabase
      .from('orders')
      .insert({
        product_name:   productName,
        quantity:       quantity,
        amount_total:   price,
        customer_name:  customerName,
        customer_email: customerEmail,
        phone:          phone,
        address:        address,
        label_name:     labelName,
        notes:          notes,
        // QR landing-page fields
        qr_name:        orNull(qr.name),
        qr_phone:       orNull(qr.phone),
        qr_email:       orNull(qr.email),
        qr_address:     orNull(qr.address),
        qr_school:      orNull(qr.school),
        qr_class:       orNull(qr.class),
        qr_teacher:     orNull(qr.teacher),
        qr_note:        orNull(qr.note),
        status:         'pending',
      })
      .select()
      .single();
    if (dbError) throw dbError;

    // 2. Create Stripe checkout session — only the row ID travels through Stripe.
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: customerEmail,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: productName,
            description: `Personalised QR labels — printed for ${labelName}`,
          },
          unit_amount: price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: {
        order_id:   order.id,
        label_name: labelName,
      },
      success_url: `${process.env.SITE_URL}/?success=true`,
      cancel_url:  `${process.env.SITE_URL}/`,
    });

    // 3. Store the Stripe session ID against the order
    await supabase
      .from('orders')
      .update({ stripe_session_id: session.id })
      .eq('id', order.id);

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Checkout error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to create checkout session' }),
    };
  }
};
