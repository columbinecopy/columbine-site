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
  const val = (v) => `<span style="font-weight:700;color:#1a0a2e">${v}</span>`;

  const lines = [
    `<b>File:</b> ${val(item.fileName)}`,
    `<b>Format:</b> ${val(item.format === 'large' ? 'Large Format' : 'Small Format')}`,
    `<b>Size:</b> ${val(sizeLabels[item.paperSize] || item.paperSize)}`,
    item.format === 'small'
      ? `<b>Paper:</b> ${val(item.paperWeight)}`
      : `<b>Media:</b> ${val(mediaLabels[item.mediaType] || item.mediaType)}`,
    `<b>Color:</b> ${val(item.color === 'color' ? '🎨 Full Color' : '⬛ Black & White')}`,
    item.sides ? `<b>Sides:</b> ${val(item.sides === 'double' ? 'Double-sided' : 'Single-sided')}` : '',
    `<b>Pages:</b> ${val(item.rangeStr || 'All Pages')} ${item.totalPages ? `(${item.totalPages} total)` : ''}`,
    `<b>Copies:</b> ${val(item.copies)}`,
    item.binding ? `<b>Binding:</b> ${val(item.bindType ? item.bindType.charAt(0).toUpperCase()+item.bindType.slice(1) : 'Yes')}` : `<b>Binding:</b> ${val('None')}`,
    item.lamination ? `<b>Lamination:</b> ${val('✅ Yes')}` : `<b>Lamination:</b> ${val('No')}`,
    item.holePunch ? `<b>Hole Punch:</b> ${val('✅ Yes')}` : '',
    item.notes ? `<b>Notes:</b><div style="margin-top:4px;padding:8px 10px;background:#fff;border:1px solid #d4c8e8;border-radius:4px;white-space:pre-wrap;word-break:break-word">${item.notes}</div>` : '',
    `<b>Item Total:</b> ${val('$'+Number(item.price || 0).toFixed(2))}`,
  ].filter(Boolean);

  return `
    <div style="background:#f4f0fb;border:1px solid #d4c8e8;border-radius:6px;padding:12px 14px;margin-bottom:10px">
      <div style="font-weight:700;color:#1a0a2e;font-size:.9rem;margin-bottom:8px;border-bottom:1px solid #d4c8e8;padding-bottom:5px">Item ${index + 1}</div>
      ${lines.map(l => `<div style="font-size:0.82rem;color:#333;margin-bottom:4px;line-height:1.3">${l}</div>`).join('')}
    </div>`;
}

// ── Generate Work Order HTML ─────────────────────────────────────────────────
function generateWorkOrderHTML(orderId, totalAmount, subtotalAmount, taxAmount, customer, cartItems, orderNotes) {
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

  const val = (v) => `<span style="font-weight:700;color:#1a0a2e">${v}</span>`;

  const itemHtml = (item, index) => {
    const lines = [
      `<b>File:</b> ${val(item.fileName)}`,
      `<b>Format:</b> ${val(item.format === 'large' ? 'Large Format' : 'Small Format')}`,
      `<b>Size:</b> ${val(sizeLabels[item.paperSize] || item.paperSize)}`,
      item.format === 'small'
        ? `<b>Paper:</b> ${val(item.paperWeight)}`
        : `<b>Media:</b> ${val(mediaLabels[item.mediaType] || item.mediaType)}`,
      `<b>Color:</b> ${val(item.color === 'color' ? '🎨 Full Color' : '⬛ Black & White')}`,
      item.sides ? `<b>Sides:</b> ${val(item.sides === 'double' ? 'Double-sided' : 'Single-sided')}` : '',
      `<b>Pages:</b> ${val(item.rangeStr || 'All Pages')} ${item.totalPages ? `(${item.totalPages} total)` : ''}`,
      `<b>Copies:</b> ${val(item.copies)}`,
      item.binding ? `<b>Binding:</b> ${val(item.bindType ? item.bindType.charAt(0).toUpperCase()+item.bindType.slice(1) : 'Yes')}` : `<b>Binding:</b> ${val('None')}`,
      item.lamination ? `<b>Lamination:</b> ${val('✅ Yes')}` : `<b>Lamination:</b> ${val('No')}`,
      item.holePunch ? `<b>Hole Punch:</b> ${val('✅ Yes')}` : '',
      item.notes ? `<b>Notes:</b><div style="margin-top:4px;padding:6px 8px;background:#fff;border:1px solid #d4c8e8;border-radius:3px;white-space:pre-wrap;word-break:break-word;font-size:0.82rem">${item.notes}</div>` : '',
      `<b>Item Total:</b> ${val('$'+Number(item.price || 0).toFixed(2))}`,
    ].filter(Boolean);

    return `<div style="background:#f4f0fb;border:1px solid #d4c8e8;border-radius:6px;padding:12px 14px;margin-bottom:10px;break-inside:avoid">
      <div style="font-weight:700;color:#1a0a2e;font-size:.9rem;margin-bottom:8px;border-bottom:1px solid #d4c8e8;padding-bottom:5px">Item ${index + 1}</div>
      ${lines.map(l => `<div style="font-size:0.82rem;color:#333;margin-bottom:4px;line-height:1.3">${l}</div>`).join('')}
    </div>`;
  };

  const items = cartItems || [];
  const gridRows = [];
  for (let i = 0; i < items.length; i += 2) {
    gridRows.push(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:0">
      ${itemHtml(items[i], i)}
      ${items[i+1] ? itemHtml(items[i+1], i+1) : '<div></div>'}
    </div>`);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10px; color: #333; padding: 16px; }
  @media print { body { padding: 8px; } @page { margin: 0.5in; size: letter; } }
</style>
</head>
<body>

<div style="background:#1a0a2e;padding:14px 20px;border-radius:6px 6px 0 0">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div>
      <h1 style="color:#c8a0f0;font-size:1.2rem;margin:0">New Print Order</h1>
      <p style="color:#9a8ab0;margin:4px 0 0;font-size:.85rem">Order ${orderId} &nbsp;·&nbsp; $${totalAmount} paid &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}</p>
    </div>
  </div>
</div>

<div style="background:#fff;padding:16px 20px;border:1px solid #d4c8e8;border-top:none;border-radius:0 0 6px 6px;margin-bottom:12px">
  <div style="background:#f4f0fb;border-radius:6px;padding:12px 16px;margin-bottom:14px;font-size:.88rem">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><b>Name:</b> <span style="font-weight:700;color:#1a0a2e">${customer?.name || '—'}</span></div>
      <div><b>Email:</b> <a href="mailto:${customer?.email}" style="color:#6b27b8">${customer?.email || '—'}</a></div>
      <div><b>Pickup Name:</b> <span style="font-weight:700;color:#6b27b8;font-size:1rem">${customer?.pickupName || customer?.name || '—'}</span></div>
      <div><b>Phone:</b> ${customer?.phone || '—'}</div>
    </div>
    ${orderNotes ? `<div style="margin-top:8px"><b>Order Notes:</b><div style="margin-top:4px;padding:6px 8px;background:#fff;border:1px solid #d4c8e8;border-radius:3px;white-space:pre-wrap;word-break:break-word">${orderNotes}</div></div>` : ''}
  </div>

  ${gridRows.join('')}

  <div style="background:#1a0a2e;border-radius:6px;padding:12px 16px;margin-top:8px">
    <div style="color:#9a8ab0;font-size:.78rem;margin-bottom:2px">Subtotal: $${subtotalAmount} &nbsp;·&nbsp; Tax (8.53%): $${taxAmount}</div>
    <div style="color:#9a8ab0;font-size:.82rem;text-transform:uppercase;letter-spacing:1px">Total Paid</div>
    <div style="color:#c8a0f0;font-size:1.5rem;font-weight:700">$${totalAmount}</div>
  </div>
</div>

</body>
</html>`;
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

  console.log('Payment request — amountCents:', amountCents, 'files:', pdfFiles?.length || 0, 'cartItems:', cartItems?.length || 0);
  if (!cartItems || cartItems.length === 0) {
    console.log('WARNING: cartItems is empty or missing');
  }

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

  // ── Generate Work Order HTML ──────────────────────────────────────────────
  let workOrderPdfBase64 = null;
  try {
    const htmlContent = generateWorkOrderHTML(orderId, totalAmount, subtotalAmount, taxAmount, customer, cartItems, orderNotes);
    workOrderPdfBase64 = Buffer.from(htmlContent).toString('base64');
    console.log('✅ Work order generated');
  } catch(e) {
    console.error('Work order generation failed:', e.message);
  }

  // ── 2. Build PDF links and attachments ───────────────────────────────────
  const attachments = [];
  // Attach work order PDF if generated
  if (workOrderPdfBase64) {
    attachments.push({ filename: `WorkOrder-${orderId}.html`, content: workOrderPdfBase64 });
  }
  const fileLinks = []; // Bytescale download links
  if (pdfFiles && pdfFiles.length > 0) {
    for (const f of pdfFiles) {
      if (f.url) {
        // Bytescale URL — add as a download link in the email
        fileLinks.push({ name: f.name, url: f.url });
        console.log(`✅ Bytescale link: ${f.name} → ${f.url}`);
      } else if (f.data && !f.tooLarge) {
        // Small file base64 fallback — attach directly
        try {
          const clean = f.data.replace(/^data:[^;]+;base64,/, '');
          attachments.push({ filename: f.name, content: clean });
          console.log(`✅ Attached: ${f.name}`);
        } catch(e) {
          console.error(`Could not attach ${f.name}:`, e.message);
        }
      } else {
        console.log(`⚠️ File unavailable: ${f.name}`);
      }
    }
  }

  // Build cart HTML in two-column grid layout
  // Page 1: customer info + 4 items (2 columns x 2 rows)
  // Page 2+: 6 items per page (2 columns x 3 rows)
  const items = cartItems || [];
  
  const buildGrid = (itemsSlice, startIndex) => {
    const rows = [];
    for (let i = 0; i < itemsSlice.length; i += 2) {
      const left = itemsSlice[i] ? formatCartItem(itemsSlice[i], startIndex + i) : '';
      const right = itemsSlice[i+1] ? formatCartItem(itemsSlice[i+1], startIndex + i + 1) : '<div></div>';
      rows.push(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:0">${left}${right}</div>`);
    }
    return rows.join('');
  };

  // Page 1 gets first 4 items, subsequent pages get 6 items each
  const page1Items = items.slice(0, 4);
  const remainingItems = items.slice(4);
  
  let cartHtml = buildGrid(page1Items, 0);
  
  // Add extra pages if needed
  for (let p = 0; p < remainingItems.length; p += 6) {
    const pageItems = remainingItems.slice(p, p + 6);
    cartHtml += `<div style="page-break-before:always;margin-top:20px">
      <div style="background:#1a0a2e;padding:12px 20px;border-radius:6px 6px 0 0;margin-bottom:10px">
        <p style="color:#9a8ab0;margin:0;font-size:.85rem">Order ${orderId} — continued</p>
      </div>
      ${buildGrid(pageItems, 4 + p)}
    </div>`;
  }

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
        <div style="background:#f4f0fb;border-radius:6px;padding:16px 20px;margin-bottom:20px;font-size:.95rem">
          <div style="margin-bottom:6px"><b>Name:</b> <span style="font-weight:700;color:#1a0a2e">${customer?.name || '—'}</span></div>
          <div style="margin-bottom:6px"><b>Pickup Name:</b> <span style="font-weight:700;color:#6b27b8;font-size:1.05rem">${customer?.pickupName || customer?.name || '—'}</span></div>
          <div style="margin-bottom:6px"><b>Email:</b> <a href="mailto:${customer?.email}" style="color:#6b27b8;font-weight:500">${customer?.email || '—'}</a></div>
          <div style="margin-bottom:6px"><b>Phone:</b> ${customer?.phone || '—'}</div>
          ${orderNotes ? `<div style="margin-top:8px"><b>Order Notes:</b><div style="margin-top:4px;padding:8px 10px;background:#fff;border:1px solid #d4c8e8;border-radius:4px;white-space:pre-wrap;word-break:break-word">${orderNotes}</div></div>` : ''}
        </div>
        ${fileLinks.length > 0 ? `
          <div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;padding:12px 16px;margin-bottom:16px">
            <div style="color:#2e7d32;font-size:.88rem;font-weight:700;margin-bottom:8px">📎 PDF Download Links</div>
            ${fileLinks.map(f => `<div style="margin-bottom:6px;font-size:.88rem">
              📄 <a href="${f.url}" style="color:#6b27b8;font-weight:600">${f.name}</a>
              &nbsp;—&nbsp; <a href="${f.url}" style="color:#6b27b8">⬇ Download</a>
            </div>`).join('')}
          </div>` : ''}
        ${attachments.length > 0 ? `
          <p style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;padding:12px;color:#2e7d32;font-size:.88rem">
            📎 ${attachments.length} PDF file${attachments.length > 1 ? 's' : ''} attached to this email
          </p>` : ''}
        ${fileLinks.length === 0 && attachments.length === 0 ? `
          <p style="background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:12px;color:#e65100;font-size:.88rem">
            ⚠ No PDF files received — please follow up with the customer
          </p>` : ''}
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
    attachments,
    customer?.email || null  // Reply-To set to customer email
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
