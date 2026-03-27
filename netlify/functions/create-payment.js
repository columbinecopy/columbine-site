/**
 * Columbine Copy & Apparel — Payment + Upload + Email Function
 */

const { Client, Environment, ApiError } = require('square');
const { randomUUID } = require('crypto');
const https = require('https');
const crypto = require('crypto');

// ── HTTPS helper ─────────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) {
      if (Buffer.isBuffer(body)) req.write(body);
      else req.write(body);
    }
    req.end();
  });
}

// ── Upload PDF to Cloudinary ──────────────────────────────────────────────────
async function uploadToCloudinary(base64Data, fileName, orderId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `print-orders/${orderId}/${fileName.replace(/\.pdf$/i, '')}`;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  // Signature must include ONLY the params being signed (NOT api_key, NOT file, NOT resource_type)
  // Must be alphabetically sorted
  const sigParams = { public_id: publicId, timestamp };
  const sigStr = Object.keys(sigParams).sort()
    .map(k => `${k}=${sigParams[k]}`).join('&') + apiSecret;
  const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

  // Convert base64 to binary buffer
  const fileBuffer = Buffer.from(base64Data, 'base64');

  // Build multipart form data with binary PDF
  const boundary = '----FormBoundary' + randomUUID().replace(/-/g, '');
  const CRLF = '\r\n';

  const parts = [];
  const addField = (name, value) => {
    parts.push(
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`, 'utf8'),
      Buffer.from(String(value), 'utf8'),
      Buffer.from(CRLF, 'utf8')
    );
  };

  // Add text fields
  addField('public_id', publicId);
  addField('timestamp', timestamp.toString());
  addField('api_key', apiKey);
  addField('signature', signature);
  addField('resource_type', 'raw');

  // Add file as binary
  parts.push(
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: application/pdf${CRLF}${CRLF}`, 'utf8'),
    fileBuffer,
    Buffer.from(CRLF, 'utf8')
  );

  // Close boundary
  parts.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));

  const payload = Buffer.concat(parts);

  const result = await httpsRequest({
    hostname: 'api.cloudinary.com',
    path: `/v1_1/${cloudName}/raw/upload`,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': payload.length,
    },
  }, payload);

  console.log('Cloudinary response status:', result.status);
  console.log('Cloudinary response:', JSON.stringify(result.body).substring(0, 300));

  if (result.status !== 200) {
    throw new Error(`Cloudinary upload failed: ${JSON.stringify(result.body)}`);
  }
  return result.body.secure_url;
}

// ── Send email via Resend ─────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const payload = JSON.stringify({
    from: `Columbine Copy & Apparel <${process.env.OWNER_EMAIL}>`,
    to: [to],
    subject,
    html,
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
    console.error('Resend error:', result.body);
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
  const orderId = 'CCA-' + Math.floor(100000 + Math.random() * 900000);

  // ── 1. Upload PDFs to Cloudinary ──────────────────────────────────────────
  const uploadedFiles = [];
  if (pdfFiles && pdfFiles.length > 0) {
    for (const pdfFile of pdfFiles) {
      try {
        const url = await uploadToCloudinary(pdfFile.data, pdfFile.name, orderId);
        uploadedFiles.push({ name: pdfFile.name, url });
        console.log(`✅ Uploaded: ${pdfFile.name}`);
      } catch(e) {
        console.error(`Upload failed for ${pdfFile.name}:`, e.message);
        uploadedFiles.push({ name: pdfFile.name, url: null });
      }
    }
  }

  // ── 2. Charge via Square ──────────────────────────────────────────────────
  const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.NODE_ENV === 'production'
      ? Environment.Production : Environment.Sandbox,
  });

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

    const payment = response.result.payment;
    console.log(`✅ Payment success — ${orderId} — $${totalAmount}`);

    // ── 3. Email owner ────────────────────────────────────────────────────
    const fileLinksHtml = uploadedFiles.length > 0
      ? uploadedFiles.map(f => f.url
          ? `<div style="margin-bottom:8px">📄 <a href="${f.url}" style="color:#6b27b8;font-weight:600">${f.name}</a> — <a href="${f.url}" style="color:#6b27b8">⬇ Download PDF</a></div>`
          : `<div style="margin-bottom:8px">📄 ${f.name} — <span style="color:#cc0000">⚠ Upload failed — customer will need to resend</span></div>`
        ).join('')
      : '<p style="color:#999;font-style:italic">No files were uploaded with this order</p>';

    const cartHtml = (cartItems || []).map((item, i) => formatCartItem(item, i)).join('');

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
          <h2 style="color:#1a0a2e;font-size:1rem;margin:0 0 10px">PDF Files</h2>
          <div style="margin-bottom:20px">${fileLinksHtml}</div>
          <h2 style="color:#1a0a2e;font-size:1rem;margin:0 0 10px">Order Details</h2>
          ${cartHtml}
          <div style="background:#1a0a2e;border-radius:6px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin-top:16px">
            <span style="color:#9a8ab0;font-size:.85rem;text-transform:uppercase;letter-spacing:1px">Total Paid</span>
            <span style="color:#c8a0f0;font-size:1.5rem;font-weight:700">$${totalAmount}</span>
          </div>
          <p style="color:#999;font-size:.78rem;margin-top:16px">Payment ID: ${payment.id}</p>
        </div>
      </div>`
    );

    // ── 4. Email customer ─────────────────────────────────────────────────
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
            <p style="color:#555;font-size:.88rem">We will contact you when your order is ready for pickup.</p>
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

  } catch(error) {
    if (error instanceof ApiError) {
      const msg = error.errors?.map(e => e.detail).join('; ') || 'Payment failed.';
      console.error('Square error:', msg);
      return { statusCode: 402, body: JSON.stringify({ success: false, error: msg }) };
    }
    console.error('Server error:', error);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Server error. Please try again.' }) };
  }
};
