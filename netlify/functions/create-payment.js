/**
 * Columbine Copy & Apparel — Payment + Email Function
 * PDF files are sent as base64 attachments directly via Resend
 * No Cloudinary needed!
 */

const { Client, Environment, ApiError } = require('square');
const { randomUUID } = require('crypto');
const https = require('https');

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch(e) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : body);
    req.end();
  });
}

// ── Send email via Resend (with optional PDF attachments) ─────────────────────
async function sendEmail(to, subject, html, attachments = []) {
  const payload = JSON.stringify({
    from: `Columbine Copy & Apparel <${process.env.OWNER_EMAIL}>`,
    to: [to],
    subject,
    html,
    attachments, // [{ filename, content (base64) }]
  });

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
  } else {
    console.log('✅ Email sent to:', to);
  }
  return result;
}

// ── Format cart item for email ────────────────────────────────────────────────
function formatCartItem(item, index) {
  const sizeLabels = {
    letter:'Letter', legal:'Legal', a4:'A4', tabloid:'Tabloid',
    'arch-a':'Arch A','arch-b':'Arch B','arch-c':'Arch C','arch-d':'Arch D',
    'arch-e':'Arch E','arch-e1':'Arch E1','arch-e2':'Arch E2','arch-e3':'Arch E3',
    'ansi-c':'ANSI C','ansi-d':'ANSI D','ansi-e':'ANSI E',
  };
  const mediaLabels = {
    bond20:'Standard Bond (20lb)', bond36:'Heavyweight Bond (36lb)',
    mylar:'Mylar Film', vellum:'Vellum', photo:'Photo Paper',
  };
  const lines = [
    `<b>File:</b> ${item.fileName}`,
    `<b>Format:</b> ${item.format === 'large' ? 'Large Format' : 'Small Format'}`,
    `<b>Size:</b> ${sizeLabels[item.paperSize] || item.paperSize}`,
    item.format === 'small'
      ? `<b>Paper:</b> ${item.paperWeight}`
      : `<b>Media:</b> ${mediaLabels[item.mediaType] || item.mediaType}`,
    `<b>Color:</b> ${item.color === 'color' ? 'Full Color' : 'Black & White'}`,
    item.sides ? `<b>Sides:</b> ${item.sides === 'double' ? 'Double-sided' : 'Single-sided'}` : '',
    `<b>Pages:</b> ${item.rangeStr || 'All'} ${item.totalPages ? `(${item.totalPages} pages)` : ''}`,
    `<b>Copies:</b> ${item.copies}`,
    item.binding ? `<b>Binding:</b> ${item.bindType || 'Yes'}` : '',
    item.lamination ? `<b>Lamination:</b> ${item.lamType || 'Yes'}` : '',
    item.holePunch ? `<b>Hole Punch:</b> Yes` : '',
    item.notes ? `<b>Notes:</b> ${item.notes}` : '',
    `<b>Item Total:</b> $${Number(item.price || 0).toFixed(2)}`,
  ].filter(Boolean);

  return `
    <div style="background:#f4f0fb;border:1px solid #d4c8e8;border-radius:6px;padding:14px 18px;margin-bottom:12px">
      <div style="font-weight:700;color:#1a0a2e;margin-bottom:8px">Item ${index + 1}</div>
      ${lines.map(l => `<div style="font-size:0.88rem;color:#333;margin-bottom:3px">${l}</div>`).join('')}
    </div>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { sourceId, amountCents, currency, customer, cartItems, orderNotes, pdfFiles } = body;

  console.log('Payment request — amountCents:', amountCents, 'files:', pdfFiles?.length || 0);

  if (!sourceId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing payment token.' }) };
  }
  if (!amountCents || isNaN(amountCents) || amountCents < 1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid order amount.' }) };
  }

  const finalAmount = Math.max(Number(amountCents), 100);
  const totalAmount = (finalAmount / 100).toFixed(2);
  const subtotalAmount = (finalAmount / 100 / 1.0853).toFixed(2);
  const taxAmount = ((finalAmount / 100) - (finalAmount / 100 / 1.0853)).toFixed(2);
  const orderId = 'CCA-' + Math.floor(100000 + Math.random() * 900000);

  // ── 1. Charge via Square ──────────────────────────────────────────────────
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
      amountMoney: { amount: BigInt(finalAmount), currency: currency || 'USD' },
      locationId: process.env.SQUARE_LOCATION_ID,
      referenceId: orderId,
      note: `Columbine Print Order ${orderId} — ${customer?.name || 'Customer'}`,
      buyerEmailAddress: customer?.email,
    });
    payment = response.result.payment;
    console.log(`✅ Payment success — ${orderId} — $${totalAmount}`);
  } catch(error) {
    if (error instanceof ApiError) {
      const msg = error.errors?.map(e => e.detail).join('; ') || 'Payment failed.';
      console.error('Square error:', msg);
      return { statusCode: 402, body: JSON.stringify({ success: false, error: msg }) };
    }
    console.error('Payment error:', error);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Payment failed. Please try again.' }) };
  }

  // ── 2. Build PDF attachments for email ────────────────────────────────────
  const attachments = [];
  if (pdfFiles && pdfFiles.length > 0) {
    for (const f of pdfFiles) {
      try {
        const clean = f.data.replace(/^data:[^;]+;base64,/, '');
        attachments.push({ filename: f.name, content: clean });
        console.log(`✅ Attached: ${f.name} (${Math.round(clean.length * 0.75 / 1024)}KB)`);
      } catch(e) {
        console.error(`Could not attach ${f.name}:`, e.message);
      }
    }
  }

  const cartHtml = (cartItems || []).map((item, i) => formatCartItem(item, i)).join('');

  // ── 3. Email owner with PDF attachments ───────────────────────────────────
  await sendEmail(
    process.env.OWNER_EMAIL,
    `🖨 New Print Order ${orderId} — $${totalAmount} — ${customer?.name}`,
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a0a2e;padding:24px;border-radius:6px 6px 0 0">
        <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">New Print Order</h1>
        <p style="color:#9a8ab0;margin:6px 0 0">Order ${orderId} &nbsp;·&nbsp; $${totalAmount} paid</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none">
        <h2 style="color:#1a0a2e;font-size:1rem;margin:0 0 10px">Customer</h2>
        <div style="background:#f4f0fb;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:.88rem">
          <div><b>Name:</b> ${customer?.name || '—'}</div>
          <div><b>Email:</b> ${customer?.email || '—'}</div>
          <div><b>Phone:</b> ${customer?.phone || '—'}</div>
          ${orderNotes ? `<div><b>Notes:</b> ${orderNotes}</div>` : ''}
        </div>
        ${attachments.length > 0
          ? `<p style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;padding:12px;color:#2e7d32;font-size:.88rem">
              📎 ${attachments.length} PDF file${attachments.length > 1 ? 's' : ''} attached to this email
             </p>`
          : `<p style="background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:12px;color:#e65100;font-size:.88rem">
              ⚠ No PDF files were attached — customer may need to resend
             </p>`
        }
        <h2 style="color:#1a0a2e;font-size:1rem;margin:16px 0 10px">Order Details</h2>
        ${cartHtml}
        <div style="background:#1a0a2e;border-radius:6px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin-top:16px">
          <div>
            <div style="color:#9a8ab0;font-size:.78rem;margin-bottom:2px">Subtotal: $${subtotalAmount}</div>
            <div style="color:#9a8ab0;font-size:.78rem;margin-bottom:6px">Tax (8.53%): $${taxAmount}</div>
            <div style="color:#9a8ab0;font-size:.85rem;text-transform:uppercase;letter-spacing:1px">Total Paid</div>
            <div style="color:#c8a0f0;font-size:1.5rem;font-weight:700">$${totalAmount}</div>
          </div>
        </div>
        <p style="color:#999;font-size:.78rem;margin-top:16px">Payment ID: ${payment.id}</p>
      </div>
    </div>`,
    attachments
  );

  // ── 4. Email customer confirmation ────────────────────────────────────────
  if (customer?.email) {
    await sendEmail(
      customer.email,
      `Your print order is confirmed — ${orderId}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a0a2e;padding:24px;border-radius:6px 6px 0 0;text-align:center">
          <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">Order Confirmed!</h1>
          <p style="color:#9a8ab0;margin:6px 0 0">Columbine Copy & Apparel</p>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none;text-align:center">
          <p style="color:#333">Hi ${customer.name?.split(' ')[0] || 'there'},</p>
          <p style="color:#555;font-size:.9rem">Thank you for your order! We have received your payment and will begin processing your print job shortly.</p>
          <div style="background:#f4f0fb;border-radius:6px;padding:16px;margin:20px 0;display:inline-block">
            <div style="color:#6e5a8a;font-size:.78rem;text-transform:uppercase;letter-spacing:1px">Order Reference</div>
            <div style="color:#1a0a2e;font-size:1.4rem;font-weight:700;font-family:monospace;letter-spacing:2px">${orderId}</div>
          </div>
          <p style="color:#333">Total paid: <b>$${totalAmount}</b></p>
          <p style="color:#555;font-size:.88rem">Your order will be printed during normal business hours and you will be notified by email once it is ready for pickup — usually within 30 minutes.</p>
          <p style="color:#999;font-size:.78rem;margin-top:24px">Columbine Copy & Apparel · All files are kept confidential and deleted after printing</p>
        </div>
      </div>`
    );
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, orderId, paymentId: payment.id }),
  };
};
