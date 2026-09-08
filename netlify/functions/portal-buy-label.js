// portal-buy-label.js
// Self-service customer portal: charges Square FIRST, and only on a
// successful charge does it purchase the actual Shippo label. This
// ordering matters — we never buy a label before being paid for it.
// Mirrors the Square + Resend patterns already used in create-payment.js.

const { Client, Environment, ApiError } = require('square');
const { randomUUID } = require('crypto');
const https = require('https');

const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
const PORTAL_PIN = process.env.PORTAL_PIN;

const ALLOWED_ORIGINS = [
  'https://www.columbinecopy.com',
  'https://columbinecopy.com',
  'https://print.columbinecopy.com',
];

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const text = rawBody.toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(text), rawBody }); }
        catch (e) { resolve({ status: res.statusCode, body: text, rawBody }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : body);
    req.end();
  });
}

async function sendEmail(to, subject, html, attachments = [], replyTo = null) {
  const emailData = {
    from: `Columbine Copy & Apparel <${process.env.OWNER_EMAIL}>`,
    to: [to],
    subject,
    html,
    attachments,
  };
  if (replyTo) emailData.reply_to = replyTo;
  const payload = JSON.stringify(emailData);

  const result = await httpsRequest({
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
  }, payload);

  if (result.status !== 200 && result.status !== 201) {
    console.error('Resend error:', JSON.stringify(result.body));
  }
  return result;
}

exports.handler = async function (event) {
  const cors = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { pin, sourceId, rateId, amountCents, customerName, customerEmail } = body;

  if (!PORTAL_PIN || pin !== PORTAL_PIN) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorized.' }) };
  }
  if (!sourceId) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing payment token.' }) };
  }
  if (!rateId) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing selected rate.' }) };
  }
  if (!amountCents || isNaN(amountCents) || amountCents < 1) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid order amount.' }) };
  }
  if (!SHIPPO_API_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Shipping service not configured.' }) };
  }

  const finalAmount = Math.round(Number(amountCents));
  const totalAmount = (finalAmount / 100).toFixed(2);
  const orderId = 'SHIP-' + Math.floor(100000 + Math.random() * 900000);

  // ── 1. Charge via Square — must succeed before we spend anything on Shippo ──
  const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.NODE_ENV === 'production'
      ? Environment.Production : Environment.Sandbox,
  });

  let payment;
  try {
    const response = await squareClient.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: randomUUID(),
      amountMoney: { amount: BigInt(finalAmount), currency: 'USD' },
      locationId: process.env.SQUARE_LOCATION_ID,
      referenceId: orderId,
      note: `Shipping Label ${orderId} — ${customerName || 'Customer'}`,
      buyerEmailAddress: customerEmail,
    });
    payment = response.result.payment;
    console.log(`✅ Portal payment success — ${orderId} — $${totalAmount}`);
  } catch (error) {
    if (error instanceof ApiError) {
      const msg = error.errors?.map((e) => e.detail).join('; ') || 'Payment failed.';
      console.error('Square error:', msg);
      return { statusCode: 402, headers: cors, body: JSON.stringify({ success: false, error: msg }) };
    }
    console.error('Payment error:', error);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: 'Payment failed. Please try again.' }) };
  }

  // ── 2. Payment succeeded — now actually purchase the Shippo label ──────────
  let labelUrl, trackingNumber, carrier;
  try {
    const txResponse = await fetch('https://api.goshippo.com/transactions/', {
      method: 'POST',
      headers: {
        Authorization: `ShippoToken ${SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rate: rateId, label_file_type: 'PDF_4x6', async: false }),
    });
    const txData = await txResponse.json();

    if (!txResponse.ok || txData.status !== 'SUCCESS') {
      console.error('Shippo transaction error after successful payment:', JSON.stringify(txData));
      // Payment already succeeded but label purchase failed — this needs a
      // human to sort out (refund or manual label), so we flag it clearly
      // rather than silently losing the money.
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({
          success: false,
          error: 'Payment was processed but the shipping label could not be created. Please contact us right away — your payment ID is ' + payment.id,
        }),
      };
    }

    labelUrl = txData.label_url;
    trackingNumber = txData.tracking_number;
    carrier = txData.rate?.provider;
  } catch (err) {
    console.error('Shippo purchase error after successful payment:', err);
    return {
      statusCode: 502,
      headers: cors,
      body: JSON.stringify({
        success: false,
        error: 'Payment was processed but the shipping label could not be created. Please contact us right away — your payment ID is ' + payment.id,
      }),
    };
  }

  // ── 3. Email owner — so staff know a label is coming before drop-off ───────
  await sendEmail(
    process.env.OWNER_EMAIL,
    `📦 New Self-Service Shipping Order ${orderId} — $${totalAmount} — ${customerName || 'Customer'}`,
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a0a2e;padding:24px;border-radius:6px 6px 0 0">
        <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">New Shipping Portal Order</h1>
        <p style="color:#9a8ab0;margin:6px 0 0">Order ${orderId} &nbsp;·&nbsp; $${totalAmount} paid</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none">
        <div style="background:#f4f0fb;border-radius:6px;padding:16px 20px;margin-bottom:16px">
          <div style="margin-bottom:6px"><b>Customer:</b> ${customerName || '—'}</div>
          <div style="margin-bottom:6px"><b>Email:</b> ${customerEmail || '—'}</div>
          <div style="margin-bottom:6px"><b>Carrier:</b> ${carrier || '—'}</div>
          <div style="margin-bottom:6px"><b>Tracking #:</b> ${trackingNumber || '—'}</div>
        </div>
        <p style="color:#555;font-size:.9rem">This customer paid and printed their own label. Expect the package at drop-off.</p>
        <p style="color:#999;font-size:.78rem;margin-top:16px">Payment ID: ${payment.id}</p>
      </div>
    </div>`
  );

  // ── 4. Email customer confirmation ──────────────────────────────────────
  if (customerEmail) {
    await sendEmail(
      customerEmail,
      `Your shipping label is ready — ${orderId}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a0a2e;padding:24px;border-radius:6px 6px 0 0;text-align:center">
          <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">Label Ready!</h1>
          <p style="color:#9a8ab0;margin:6px 0 0">Columbine Copy & Apparel</p>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none;text-align:center">
          <p style="color:#333">Hi ${(customerName || '').split(' ')[0] || 'there'},</p>
          <p style="color:#555;font-size:.9rem">Your shipping label has been purchased. Print it from the confirmation screen, or find it attached if you requested an emailed copy.</p>
          <div style="background:#f4f0fb;border-radius:6px;padding:16px;margin:20px 0;display:inline-block">
            <div style="color:#6e5a8a;font-size:.78rem;text-transform:uppercase;letter-spacing:1px">Order Reference</div>
            <div style="color:#1a0a2e;font-size:1.4rem;font-weight:700;font-family:monospace;letter-spacing:2px">${orderId}</div>
          </div>
          <p style="color:#333">Tracking #: <b>${trackingNumber || '—'}</b></p>
          <p style="color:#333">Total paid: <b>$${totalAmount}</b></p>
          <p style="color:#999;font-size:.78rem;margin-top:24px">Columbine Copy & Apparel · 419 N. 1st Street, Montrose, CO · (970) 249-4418</p>
        </div>
      </div>`
    );
  }

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({
      success: true,
      orderId,
      paymentId: payment.id,
      labelUrl,
      trackingNumber,
      carrier,
    }),
  };
};
