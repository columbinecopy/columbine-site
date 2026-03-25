
/**
 * Columbine Copy & Apparel — Payment + Upload + Email Function
 * ------------------------------------------------------------
 * This Netlify Function:
 * 1. Receives the PDF file (as base64) + order details from the website
 * 2. Uploads the PDF to Cloudinary and gets a secure download link
 * 3. Charges the customer via Square
 * 4. Emails you the order details + PDF download link via Resend
 * 5. Emails the customer a confirmation
 *
 * Environment variables to set in Netlify dashboard:
 *   SQUARE_ACCESS_TOKEN      — from Square Developer Dashboard
 *   SQUARE_LOCATION_ID       — from Square Developer Dashboard
 *   CLOUDINARY_CLOUD_NAME    — djrmthnct
 *   CLOUDINARY_API_KEY       — 557487239997232
 *   CLOUDINARY_API_SECRET    — (from your Cloudinary dashboard — keep private)
 *   RESEND_API_KEY           — re_YriUU5ot_2bpDziSRMXYDLHEsp9MRRKpd
 *   OWNER_EMAIL              — your Gmail address
 *   NODE_ENV                 — sandbox (for testing) or production (for real payments)
 */

const { Client, Environment, ApiError } = require('square');
const { randomUUID } = require('crypto');
const https = require('https');

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Upload PDF to Cloudinary ──────────────────────────────────────────────────
async function uploadToCloudinary(base64Data, fileName, orderId) {
  const crypto = require('crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `print-orders/${orderId}/${fileName.replace('.pdf','')}`;
  
  // Generate signature
  const sigStr = `public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

  // Build multipart form data manually
  const boundary = '----CloudinaryBoundary' + randomUUID().replace(/-/g,'');
  const CRLF = '\r\n';

  const addField = (name, value) =>
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`;

  let formText = '';
  formText += addField('file', `data:application/pdf;base64,${base64Data}`);
  formText += addField('public_id', publicId);
  formText += addField('timestamp', timestamp.toString());
  formText += addField('api_key', process.env.CLOUDINARY_API_KEY);
  formText += addField('signature', signature);
  formText += addField('resource_type', 'raw');
  // Auto-delete after 60 days (in seconds)
  formText += addField('invalidate', 'true');
  formText += `--${boundary}--${CRLF}`;

  const result = await httpsPost(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload`,
    formText,
    {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    }
  );

  if (result.status !== 200) {
    console.error('Cloudinary error:', result.body);
    throw new Error('Failed to upload PDF to Cloudinary');
  }

  return result.body.secure_url;
}

// ── Send email via Resend ────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const result = await httpsPost(
    'https://api.resend.com/emails',
    {
      from: 'Columbine Copy & Apparel <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    },
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    }
  );
  if (result.status !== 200 && result.status !== 201) {
    console.error('Resend error:', result.body);
  }
  return result;
}

// ── Format order details for email ──────────────────────────────────────────
function formatCartItem(item, index) {
  const sizeLabels = {
    letter:'Letter',legal:'Legal',a4:'A4',tabloid:'Tabloid',
    'arch-a':'Arch A','arch-b':'Arch B','arch-c':'Arch C','arch-d':'Arch D',
    'arch-e':'Arch E','arch-e1':'Arch E1','arch-e2':'Arch E2','arch-e3':'Arch E3',
    'ansi-c':'ANSI C','ansi-d':'ANSI D','ansi-e':'ANSI E',
  };
  const mediaLabels = {
    bond20:'Standard Bond (20lb)',bond36:'Heavyweight Bond (36lb)',
    mylar:'Mylar Film',vellum:'Vellum',photo:'Photo Paper',
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
    `<b>Pages:</b> ${item.rangeStr} ${item.totalPages ? `(${item.totalPages} pages)` : ''}`,
    `<b>Copies:</b> ${item.copies}`,
    item.binding ? `<b>Binding:</b> ${item.bindType || 'Yes'}` : '',
    item.lamination ? `<b>Lamination:</b> ${item.lamType || 'Yes'}` : '',
    item.holePunch ? `<b>Hole Punch:</b> Yes` : '',
    item.notes ? `<b>Notes:</b> ${item.notes}` : '',
    `<b>Item Total:</b> $${item.price.toFixed(2)}`,
  ].filter(Boolean);

  return `
    <div style="background:#f4f0fb;border:1px solid #d4c8e8;border-radius:6px;padding:14px 18px;margin-bottom:12px">
      <div style="font-family:Oswald,sans-serif;font-size:1rem;font-weight:700;color:#1a0a2e;margin-bottom:8px">
        Item ${index + 1}
      </div>
      ${lines.map(l => `<div style="font-size:0.88rem;color:#333;margin-bottom:3px">${l}</div>`).join('')}
    </div>`;
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async function(event) {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const { sourceId, amountCents, currency, customer, cartItems, orderNotes, pdfFiles } = body;

  if (!sourceId || !amountCents || amountCents < 50) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payment details.' }) };
  }

  const orderId = 'CCA-' + Math.floor(100000 + Math.random() * 900000);
  const totalAmount = (amountCents / 100).toFixed(2);

  // ── 1. Upload PDFs to Cloudinary ──────────────────────────────────────────
  const uploadedFiles = [];
  if (pdfFiles && pdfFiles.length > 0) {
    for (const pdfFile of pdfFiles) {
      try {
        const downloadUrl = await uploadToCloudinary(pdfFile.data, pdfFile.name, orderId);
        uploadedFiles.push({ name: pdfFile.name, url: downloadUrl });
        console.log(`✅ Uploaded ${pdfFile.name} → ${downloadUrl}`);
      } catch(e) {
        console.error(`Failed to upload ${pdfFile.name}:`, e.message);
        uploadedFiles.push({ name: pdfFile.name, url: null });
      }
    }
  }

  // ── 2. Charge customer via Square ─────────────────────────────────────────
  const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.NODE_ENV === 'production'
      ? Environment.Production : Environment.Sandbox,
  });

  try {
    const response = await squareClient.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: randomUUID(),
      amountMoney: { amount: BigInt(amountCents), currency: currency || 'USD' },
      locationId: process.env.SQUARE_LOCATION_ID,
      referenceId: orderId,
      note: `Columbine Print Order ${orderId} — ${customer?.name || 'Customer'}`,
      buyerEmailAddress: customer?.email,
    });

    const payment = response.result.payment;
    console.log(`✅ Payment ${payment.id} — Order ${orderId} — $${totalAmount}`);

    // ── 3. Email YOU (owner) ───────────────────────────────────────────────
    const fileLinksHtml = uploadedFiles.length > 0
      ? uploadedFiles.map(f => f.url
          ? `<div style="margin-bottom:6px">📄 <a href="${f.url}" style="color:#6b27b8;font-weight:600">${f.name}</a> — <a href="${f.url}" style="color:#6b27b8">Download PDF</a></div>`
          : `<div style="margin-bottom:6px">📄 ${f.name} — <span style="color:#cc0000">Upload failed</span></div>`
        ).join('')
      : '<p style="color:#999;font-style:italic">No files uploaded</p>';

    const cartHtml = (cartItems || []).map((item, i) => formatCartItem(item, i)).join('');

    await sendEmail(
      process.env.OWNER_EMAIL,
      `🖨 New Print Order ${orderId} — $${totalAmount} — ${customer?.name}`,
      `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a0a2e;padding:24px;border-radius:6px 6px 0 0">
          <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">New Print Order Received</h1>
          <p style="color:#9a8ab0;margin:6px 0 0">Order ${orderId} · $${totalAmount} paid</p>
        </div>

        <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none">

          <h2 style="color:#1a0a2e;font-size:1rem;margin:0 0 12px">Customer</h2>
          <div style="background:#f4f0fb;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:0.88rem">
            <div><b>Name:</b> ${customer?.name || '—'}</div>
            <div><b>Email:</b> ${customer?.email || '—'}</div>
            <div><b>Phone:</b> ${customer?.phone || '—'}</div>
            ${orderNotes ? `<div><b>Order Notes:</b> ${orderNotes}</div>` : ''}
          </div>

          <h2 style="color:#1a0a2e;font-size:1rem;margin:0 0 12px">PDF Files to Print</h2>
          <div style="margin-bottom:20px">${fileLinksHtml}</div>

          <h2 style="color:#1a0a2e;font-size:1rem;margin:0 0 12px">Order Items</h2>
          ${cartHtml}

          <div style="background:#1a0a2e;border-radius:6px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center">
            <span style="color:#9a8ab0;font-size:0.85rem;text-transform:uppercase;letter-spacing:1px">Total Paid</span>
            <span style="color:#c8a0f0;font-size:1.5rem;font-weight:700">$${totalAmount}</span>
          </div>

          <p style="color:#999;font-size:0.78rem;margin-top:16px">
            Payment ID: ${payment.id} · Square Order Ref: ${orderId}
          </p>
        </div>
      </div>`
    );

    // ── 4. Email CUSTOMER confirmation ─────────────────────────────────────
    if (customer?.email) {
      await sendEmail(
        customer.email,
        `Your print order is confirmed — ${orderId}`,
        `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#1a0a2e;padding:24px;border-radius:6px 6px 0 0;text-align:center">
            <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">Order Confirmed!</h1>
            <p style="color:#9a8ab0;margin:6px 0 0">Columbine Copy & Apparel</p>
          </div>
          <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none;text-align:center">
            <p style="color:#333;font-size:0.95rem">Hi ${customer.name?.split(' ')[0] || 'there'},</p>
            <p style="color:#333;font-size:0.88rem">Thank you for your order! We have received your payment and will begin processing your print job shortly.</p>
            <div style="background:#f4f0fb;border-radius:6px;padding:16px;margin:20px 0;display:inline-block">
              <div style="color:#6e5a8a;font-size:0.78rem;text-transform:uppercase;letter-spacing:1px">Order Reference</div>
              <div style="color:#1a0a2e;font-size:1.4rem;font-weight:700;font-family:monospace;letter-spacing:2px">${orderId}</div>
            </div>
            <p style="color:#333;font-size:0.88rem">Total paid: <b>$${totalAmount}</b></p>
            <p style="color:#555;font-size:0.85rem">We will contact you when your order is ready for pickup.</p>
            <p style="color:#999;font-size:0.78rem;margin-top:24px">Columbine Copy & Apparel · All files are kept confidential and deleted after printing</p>
          </div>
        </div>`
      );
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, orderId, paymentId: payment.id }),
    };

  } catch (error) {
    if (error instanceof ApiError) {
      const msg = error.errors?.map(e => e.detail).join('; ') || 'Payment failed.';
      console.error('Square error:', msg);
      return { statusCode: 402, body: JSON.stringify({ success: false, error: msg }) };
    }
    console.error('Server error:', error);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Server error. Please try again.' }) };
  }
};
