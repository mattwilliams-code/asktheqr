const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

/* Server-side catalogue — the ONLY place prices are trusted.
   The browser sends a productKey, never a price. Keep this in step with
   the PRODUCTS object in index.html. */
const PRODUCTS = {
  starter:      { name: 'Starter Pack — 15 Labels',             price: 999,  qty: 15 },
  standard:     { name: 'Standard Pack — 30 Labels',            price: 1799, qty: 30 },
  backtoschool: { name: 'Back to School Kit — 30 Labels + Tag', price: 2299, qty: 30 },
  value:        { name: 'Value Pack — 50 Labels',               price: 2799, qty: 50 },
  tag:          { name: 'Luggage Tag',                          price: 399,  qty: 1  },
  sticker10:    { name: 'Luggage Sticker — 10 × 10 cm',         price: 599,  qty: 1  },
  sticker5:     { name: 'Laptop Sticker — 5 × 5 cm',            price: 299,  qty: 1  },
};

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
    productKey,
    customerEmail, customerName,
    phone, address, labelName, notes,
    qrDetails,
  } = body;

  // Resolve the product here rather than believing the browser.
  const product = PRODUCTS[productKey];
  if (!product) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown product' }) };
  }
  const productName = product.name;
  const price = product.price;
  const quantity = product.qty;

  // QR landing-page details — default to {} so a missing object can't crash the insert.
  // Empty optional fields are stored as NULL rather than '' for cleaner data.
  const qr = qrDetails || {};
  const orNull = (v) => (v && String(v).trim() ? String(v).trim() : null);

  // ── Minimal server-side guard rails (front end validates too) ──
  if (!customerEmail || !labelName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required order fields' }) };
  }
  if (String(labelName).length > 50) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Printed text is too long' }) };
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
            description: `Printed for ${labelName}`,
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
