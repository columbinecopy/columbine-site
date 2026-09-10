/**
 * Columbine Copy & Apparel — Review Submission Function
 * Completely separate from create-payment.js — NO Square, NO payment
 * processing of any kind. This only formats and sends two emails
 * (to the shop and to the customer) for orders submitted for review
 * before the customer commits to paying.
 */

const https = require('https');

// ── CORS: allow the main marketing site + print portal to call this function ───
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

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const text = rawBody.toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(text), rawBody }); }
        catch(e) { resolve({ status: res.statusCode, body: text, rawBody }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : body);
    req.end();
  });
}

// ── Send email via Resend (same helper/service as create-payment.js) ──────────
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
  } else {
    console.log('✅ Review email sent to:', to);
  }
  return result;
}

// ── Format one cart item for the review email (identical style to create-payment.js) ──
function formatShopCartItem(item, index) {
  const val = (v) => `<span style="font-weight:700;color:#1a0a2e">${v}</span>`;
  const methodLabel = (m) => m === 'sp' ? 'Screen Printed Inks' : 'Full Color';
  const sizeLabel = (s) => ({ small: 'Small', medium: 'Medium', large: 'Large' }[s] || s || 'Medium');

  const sides = item.sides || {};
  const sideLines = ['front', 'back'].map(side => {
    const s = sides[side];
    if (!s) return '';
    const label = side.charAt(0).toUpperCase() + side.slice(1);
    if (s.noPrint || !s.hasArtwork) return `<b>${label}:</b> ${val('No print')}`;
    const badFlag = s.artBad ? ' ⚠️ <span style="color:#b71c1c">(low-res — art fee applied)</span>' : '';
    return `<b>${label}:</b> ${val(methodLabel(s.method))} — ${val(sizeLabel(s.size))}${badFlag}`;
  }).filter(Boolean);

  const qtyBreakdown = item.qtyBreakdown || {};
  const qtyStr = Object.entries(qtyBreakdown).map(([size, qty]) => `${qty}×${size}`).join(', ') || '—';

  const artLinks = [];
  if (item.frontUrl) artLinks.push(`<a href="${item.frontUrl}" style="color:#6b27b8;font-weight:600">📎 Front Artwork</a>`);
  if (item.backUrl) artLinks.push(`<a href="${item.backUrl}" style="color:#6b27b8;font-weight:600">📎 Back Artwork</a>`);

  const lines = [
    `<b>Garment:</b> ${val(`${item.productId || ''} — ${item.productName || ''}`)} ${item.brand ? `<span style="color:#888;font-size:.78rem">(${item.brand})</span>` : ''}`,
    `<b>Color:</b> ${val(item.color || '—')}`,
    ...sideLines,
    `<b>Quantity:</b> ${val(qtyStr)} <span style="color:#888">(${item.totalQty || 0} total)</span>`,
    item.upchargeTotal > 0 ? `<b>Size Upcharges:</b> ${val('$' + Number(item.upchargeTotal).toFixed(2))}` : '',
    artLinks.length ? `<b>Artwork:</b> ${artLinks.join(' &nbsp;·&nbsp; ')}` : '<b>Artwork:</b> <span style="color:#b71c1c">⚠ none uploaded</span>',
    item.notes ? `<b>Notes:</b><div style="margin-top:4px;padding:8px 10px;background:#fff;border:1px solid #d4c8e8;border-radius:4px;white-space:pre-wrap;word-break:break-word">${item.notes}</div>` : '',
    `<b>Item Total:</b> ${val('$' + Number(item.itemTotal || 0).toFixed(2))}`,
  ].filter(Boolean);

  return `
    <div style="background:#f4f0fb;border:1px solid #d4c8e8;border-radius:6px;padding:12px 14px;margin-bottom:10px">
      <div style="font-weight:700;color:#1a0a2e;font-size:.9rem;margin-bottom:8px;border-bottom:1px solid #d4c8e8;padding-bottom:5px">Item ${index + 1}</div>
      ${lines.map(l => `<div style="font-size:0.82rem;color:#333;margin-bottom:4px;line-height:1.3">${l}</div>`).join('')}
    </div>`;
}

exports.handler = async function(event) {
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

  const { customer, cartItems, orderNotes, estimatedTotal, termsAccepted, termsAcceptedAt, fulfillment, shipping } = body;

  if (!customer?.name || !customer?.email) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing customer name or email.' }) };
  }
  if (!cartItems || cartItems.length === 0) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Your cart is empty.' }) };
  }
  if (!termsAccepted) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Terms & Conditions must be accepted.' }) };
  }

  const reviewId = 'REVIEW-' + Math.floor(100000 + Math.random() * 900000);
  const totalStr = Number(estimatedTotal || 0).toFixed(2);
  const cartHtml = cartItems.map((item, i) => formatShopCartItem(item, i)).join('');

  // ── Email the shop — clearly marked as an unpaid review request ──────────
  await sendEmail(
    process.env.OWNER_EMAIL,
    `📝 REVIEW REQUEST (Not Paid) ${reviewId} — ${customer.name}`,
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#7a4a00;padding:14px 24px;border-radius:6px 6px 0 0;text-align:center">
        <p style="color:#fff;margin:0;font-weight:700;letter-spacing:1px;font-size:.9rem">⚠️ IN REVIEW — NOT A PAID ORDER</p>
      </div>
      <div style="background:#1a0a2e;padding:24px;border-radius:0">
        <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">Apparel Review Request</h1>
        <p style="color:#9a8ab0;margin:6px 0 0">Reference ${reviewId} &nbsp;·&nbsp; Estimated total: $${totalStr} (not charged)</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none">
        <h2 style="color:#1a0a2e;font-size:1rem;margin:0 0 10px">Customer</h2>
        <div style="background:#f4f0fb;border-radius:6px;padding:16px 20px;margin-bottom:20px;font-size:.95rem">
          <div style="margin-bottom:6px"><b>Name:</b> <span style="font-weight:700;color:#1a0a2e">${customer.name}</span></div>
          <div style="margin-bottom:6px"><b>Email:</b> <a href="mailto:${customer.email}" style="color:#6b27b8;font-weight:500">${customer.email}</a></div>
          <div style="margin-bottom:6px"><b>Phone:</b> ${customer.phone || '—'}</div>
          ${orderNotes ? `<div style="margin-top:8px"><b>Order Notes:</b><div style="margin-top:4px;padding:8px 10px;background:#fff;border:1px solid #d4c8e8;border-radius:4px;white-space:pre-wrap;word-break:break-word">${orderNotes}</div></div>` : ''}
          <div style="margin-top:8px;font-size:.82rem;color:${termsAccepted ? '#2e7d32' : '#b71c1c'}">${termsAccepted ? '✅' : '⚠️'} Order Terms & Agreement ${termsAccepted ? `accepted at ${termsAcceptedAt || 'submission'}` : 'NOT confirmed accepted'}</div>
          ${fulfillment ? `<div style="margin-top:8px"><b>Preferred Fulfillment:</b> ${fulfillment === 'ship' ? '📦 Ship' : '🏬 Pickup'}</div>` : ''}
          ${fulfillment === 'ship' && shipping?.address ? `<div style="margin-top:4px;font-size:.85rem;color:#555">${shipping.address.street1 || ''}, ${shipping.address.city || ''}, ${shipping.address.state || ''} ${shipping.address.zip || ''}</div>` : ''}
        </div>
        <h2 style="color:#1a0a2e;font-size:1rem;margin:16px 0 10px">Requested Items</h2>
        ${cartHtml}
        <div style="background:#7a4a00;border-radius:6px;padding:14px 18px;margin-top:16px">
          <div style="color:#fff;font-size:.85rem;text-transform:uppercase;letter-spacing:1px">Estimated Total — Not Charged</div>
          <div style="color:#fff;font-size:1.5rem;font-weight:700">$${totalStr}</div>
        </div>
        <p style="color:#999;font-size:.78rem;margin-top:16px">No payment has been collected. Contact the customer to finalize details and take payment if they'd like to proceed.</p>
      </div>
    </div>`,
    [],
    customer.email
  );

  // ── Email the customer — clearly confirms no payment was taken ───────────
  const shopItemsHtml = cartItems.map(item => {
    const qtyBreakdown = item.qtyBreakdown || {};
    const qtyStr = Object.entries(qtyBreakdown).map(([size, qty]) => `${qty}×${size}`).join(', ') || '—';
    return `<div style="text-align:left;background:#f4f0fb;border:1px solid #d4c8e8;border-radius:6px;padding:10px 14px;margin-bottom:8px">
      <div style="font-weight:700;color:#1a0a2e;font-size:.88rem">${item.productId || ''} — ${item.productName || ''} <span style="font-weight:500;color:#6e5a8a">(${item.color || ''})</span></div>
      <div style="font-size:.8rem;color:#555;margin-top:2px">${qtyStr} &nbsp;·&nbsp; ${item.totalQty || 0} pcs &nbsp;·&nbsp; $${Number(item.itemTotal || 0).toFixed(2)}</div>
    </div>`;
  }).join('');

  await sendEmail(
    customer.email,
    `We've received your order for review — ${reviewId}`,
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#7a4a00;padding:12px 24px;text-align:center">
        <p style="color:#fff;margin:0;font-weight:700;font-size:.85rem">No payment has been taken — this is a review request</p>
      </div>
      <div style="background:#1a0a2e;padding:24px;text-align:center">
        <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">Order Submitted for Review</h1>
        <p style="color:#9a8ab0;margin:6px 0 0">Columbine Copy & Apparel</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none;text-align:center">
        <p style="color:#333">Hi ${customer.name?.split(' ')[0] || 'there'},</p>
        <p style="color:#555;font-size:.9rem">Thanks for sending over your order details! We have <b>not</b> charged you anything yet — this is a review request. We'll look over the details and artwork and reach out to confirm everything before any payment is collected.</p>
        <div style="background:#f4f0fb;border-radius:6px;padding:16px;margin:20px 0;display:inline-block">
          <div style="color:#6e5a8a;font-size:.78rem;text-transform:uppercase;letter-spacing:1px">Reference</div>
          <div style="color:#1a0a2e;font-size:1.4rem;font-weight:700;font-family:monospace;letter-spacing:2px">${reviewId}</div>
        </div>
        <div style="margin:16px 0;text-align:left"><div style="color:#6e5a8a;font-size:.78rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;text-align:center">Items Requested</div>${shopItemsHtml}</div>
        <p style="color:#333">Estimated total: <b>$${totalStr}</b> <span style="color:#999;font-size:.82rem">(not charged)</span></p>
        <p style="color:#555;font-size:.88rem">We'll be in touch soon to confirm details and, if everything looks good, get your payment and order moving.</p>
        <p style="color:#999;font-size:.78rem;margin-top:24px">Columbine Copy & Apparel · Questions? Reply to this email or call (970) 249-4418.</p>
      </div>
    </div>`
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify({ success: true, reviewId }),
  };
};
