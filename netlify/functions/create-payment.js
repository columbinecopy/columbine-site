/**
 * Columbine Copy & Apparel — Payment + Email + Google Drive Function
 * - Charges via Square
 * - Uploads print file to Google Drive (no size limit)
 * - Generates a printable PDF job ticket and emails it to owner
 * - Sends branded confirmation email to customer
 *
 * ENV VARS REQUIRED:
 *   SQUARE_ACCESS_TOKEN      — Square production access token
 *   SQUARE_LOCATION_ID       — Square location ID
 *   OWNER_EMAIL              — print@columbinecopy.com
 *   RESEND_API_KEY           — Resend API key
 *   GOOGLE_SERVICE_ACCOUNT   — Full JSON string of Google service account credentials
 *   GOOGLE_DRIVE_FOLDER_ID   — Google Drive folder ID to upload files into
 */

const { Client, Environment, ApiError } = require('square');
const { randomUUID } = require('crypto');
const https = require('https');

// ── HTTPS helper ─────────────────────────────────────────────────────────────
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

// ── Google Auth: get access token using domain-wide delegation ───────────────
// The service account impersonates print@columbinecopy.com so files are
// uploaded using that account's Drive storage quota.
async function getGoogleAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const impersonateEmail = process.env.OWNER_EMAIL; // print@columbinecopy.com
  const now = Math.floor(Date.now() / 1000);
  const { createSign } = require('crypto');

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: impersonateEmail,   // <-- impersonate the Workspace user
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${claim}`);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${claim}.${signature}`;

  const payload = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const result = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload);

  if (!result.body.access_token) {
    throw new Error('Failed to get Google access token: ' + JSON.stringify(result.body));
  }
  return result.body.access_token;
}

// ── Upload file to Google Drive ───────────────────────────────────────────────
async function uploadToGoogleDrive(accessToken, fileName, fileData, mimeType = 'application/pdf') {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const boundary = '-------CCABoundary';
  const metadata = JSON.stringify({ name: fileName, parents: folderId ? [folderId] : [] });
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const dataPart = `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${fileData}\r\n--${boundary}--`;
  const body = Buffer.from(metaPart + dataPart);

  // supportsAllDrives=true tells Google to use the folder owner's quota
  const result = await httpsRequest({
    hostname: 'www.googleapis.com',
    path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink,name',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  }, body);

  if (result.status !== 200) {
    throw new Error('Google Drive upload failed: ' + JSON.stringify(result.body));
  }

  // Make file viewable by anyone with the link
  const permPayload = JSON.stringify({ role: 'reader', type: 'anyone' });
  await httpsRequest({
    hostname: 'www.googleapis.com',
    path: `/drive/v3/files/${result.body.id}/permissions?supportsAllDrives=true`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(permPayload),
    },
  }, permPayload);

  return result.body;
}

// ── Generate PDF job ticket ──────────────────────────────────────────────────
async function generateJobTicketPDF(orderId, customer, cartItems, orderNotes, totalAmount, subtotalAmount, taxAmount, driveLinks, orderDate) {
  const PDFDocument = require('pdfkit');

  const sizeLabels = {
    letter:'Letter (8.5"x11")', legal:'Legal (8.5"x14")', a4:'A4 (210x297mm)',
    tabloid:'Tabloid (11"x17")', 'arch-a':'Arch A (9"x12")', 'arch-b':'Arch B (12"x18")',
    'arch-c':'Arch C (18"x24")', 'arch-d':'Arch D (24"x36")', 'arch-e':'Arch E (36"x48")',
    'arch-e1':'Arch E1 (30"x42")', 'arch-e2':'Arch E2 (26"x38")', 'arch-e3':'Arch E3 (27"x39")',
    'ansi-c':'ANSI C (17"x22")', 'ansi-d':'ANSI D (22"x34")', 'ansi-e':'ANSI E (34"x44")',
  };
  const mediaLabels = {
    bond20:'Standard Bond (20lb)', bond36:'Heavyweight Bond (36lb)',
    mylar:'Mylar Film', vellum:'Vellum', photo:'Photo Paper (Glossy)',
  };
  const bindLabels = {
    none:'No Binding', comb:'Comb Binding', spiral:'Spiral/Coil', staple:'Staple',
    no:'No Binding', yes:'Binding included',
  };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const purple = '#6b27b8';
    const dark   = '#1a0a2e';
    const mid    = '#6e5a8a';
    const light  = '#f4f0fb';
    const W      = 612 - 80; // page width minus margins

    // ── HEADER BAR ──
    doc.rect(40, 40, W, 64).fill(dark);

    // Logo (small, top left of header)
    const path = require('path');
    // Try multiple possible paths since Netlify Functions file structure varies
    const logoPaths = [
      '/var/task/logo.png',
      path.join(process.cwd(), 'logo.png'),
      path.join(__dirname, '..', '..', 'logo.png'),
      path.join(__dirname, '..', 'logo.png'),
      path.join(__dirname, 'logo.png'),
    ];
    let logoLoaded = false;
    for (const logoPath of logoPaths) {
      try {
        const fs = require('fs');
        if (fs.existsSync(logoPath)) {
          doc.image(logoPath, 44, 46, { height: 52, fit: [52, 52] });
          console.log('✅ Logo loaded from:', logoPath);
          logoLoaded = true;
          break;
        }
      } catch(e) { /* try next path */ }
    }
    if (!logoLoaded) {
      console.log('⚠ Logo not found, using fallback. CWD:', process.cwd(), '__dirname:', __dirname);
      doc.circle(72, 72, 20).fill(purple);
      doc.fontSize(8).fillColor('white').text('CCA', 62, 68);
    }

    // Business name & tagline
    doc.fontSize(16).font('Helvetica-Bold').fillColor('white')
       .text('Columbine Copy & Apparel', 100, 48, { width: 280 });
    doc.fontSize(7.5).font('Helvetica').fillColor('#c8a0f0')
       .text('419 N. 1st Street, Montrose, CO 81401  |  (970) 249-4418  |  ColumbineCopy.com', 100, 70);

    // Order ID box (top right)
    doc.rect(430, 44, W - 390, 52).fill(purple);
    doc.fontSize(8).font('Helvetica').fillColor('white').text('ORDER', 435, 50);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('white').text(orderId, 435, 62, { width: W - 395 });

    // ── CUSTOMER NAME (large, prominent) ──
    doc.rect(40, 114, W, 44).fill(light).stroke('#d4c8e8');
    doc.fontSize(9).font('Helvetica').fillColor(mid).text('CUSTOMER', 50, 120);
    doc.fontSize(22).font('Helvetica-Bold').fillColor(dark)
       .text(customer?.name || '—', 50, 130, { width: W - 20 });

    // ── CUSTOMER DETAILS ROW ──
    let y = 168;
    doc.rect(40, y, W, 32).fill('#ece6f7');
    doc.fontSize(7.5).font('Helvetica').fillColor(mid);
    doc.text(`Email: ${customer?.email || '—'}`, 50, y + 6);
    doc.text(`Phone: ${customer?.phone || '—'}`, 250, y + 6);
    doc.text(`Date: ${orderDate}`, 400, y + 6);
    if (orderNotes) {
      doc.text(`Notes: ${orderNotes}`, 50, y + 18, { width: W - 20 });
    }

    y = 210;

    // ── LINE ITEMS ──
    (cartItems || []).forEach((item, i) => {
      const driveLink = driveLinks[i];

      // Check if we need a new page
      if (y > 650) { doc.addPage(); y = 40; }

      // Item header bar
      doc.rect(40, y, W, 22).fill(dark);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('white')
         .text(`Item ${i + 1} — ${item.fileName || 'File'}`, 50, y + 6, { width: W - 100 });
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#c8a0f0')
         .text(`$${Number(item.price || 0).toFixed(2)}`, 40, y + 6, { width: W - 10, align: 'right' });
      y += 22;

      // Item details box
      doc.rect(40, y, W, 110).fill(light).stroke('#d4c8e8');
      y += 8;

      // Left column
      const col1 = 50, col2 = 310;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(dark);

      const details = [
        ['Format', item.format === 'large' ? 'Large Format' : 'Small Format'],
        ['Paper Size', sizeLabels[item.paperSize] || item.paperSize || '—'],
        ['Color Mode', item.color === 'color' ? 'Full Color' : 'Black & White'],
        ['Copies', String(item.copies || 1)],
      ];
      const details2 = [
        ['Media/Paper', item.format === 'small' ? (item.paperWeight || '—') : (mediaLabels[item.mediaType] || item.mediaType || '—')],
        ['Sides', item.sides === 'double' ? 'Double-sided' : 'Single-sided'],
        ['Pages', `${item.rangeStr || 'All'} ${item.totalPages ? '(' + item.totalPages + ' total)' : ''}`],
        ['Binding', bindLabels[item.bindType] || item.bindType || 'None'],
      ];

      details.forEach((d, di) => {
        doc.font('Helvetica-Bold').fillColor(mid).text(d[0] + ':', col1, y + (di * 16), { width: 80 });
        doc.font('Helvetica').fillColor(dark).text(d[1], col1 + 82, y + (di * 16), { width: 150 });
      });
      details2.forEach((d, di) => {
        doc.font('Helvetica-Bold').fillColor(mid).text(d[0] + ':', col2, y + (di * 16), { width: 80 });
        doc.font('Helvetica').fillColor(dark).text(d[1], col2 + 82, y + (di * 16), { width: 150 });
      });

      y += 68;

      // Extras row
      const extras = [];
      if (item.lamination) extras.push(`Lamination: ${item.lamType || 'Yes'}`);
      if (item.holePunch) extras.push('Hole Punch: Yes');
      if (item.notes) extras.push(`Notes: ${item.notes}`);
      if (extras.length) {
        doc.fontSize(7.5).font('Helvetica').fillColor(mid)
           .text(extras.join('  |  '), col1, y, { width: W - 20 });
        y += 12;
      }

      // Drive link intentionally omitted from printed job ticket

      // Production status checkboxes
      doc.rect(40, y, W, 22).fill('#ece6f7').stroke('#d4c8e8');
      doc.fontSize(8).font('Helvetica-Bold').fillColor(mid).text('STATUS:', 50, y + 6);
      const stages = ['In Queue', 'Printing', 'Finishing', 'Ready for Pickup'];
      stages.forEach((stage, si) => {
        const sx = 120 + (si * 110);
        doc.rect(sx, y + 5, 10, 10).stroke(mid);
        doc.fontSize(7.5).font('Helvetica').fillColor(dark).text(stage, sx + 14, y + 6);
      });
      y += 30;
    });

    // ── TOTALS ──
    if (y > 680) { doc.addPage(); y = 40; }
    y += 6;
    doc.rect(40, y, W, 52).fill(dark);
    doc.fontSize(8).font('Helvetica').fillColor('#9a8ab0')
       .text(`Subtotal: $${subtotalAmount}`, 50, y + 8)
       .text(`Tax (8.53%): $${taxAmount}`, 50, y + 20);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#9a8ab0')
       .text('TOTAL PAID', 400, y + 10);
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#c8a0f0')
       .text(`$${totalAmount}`, 400, y + 24);

    // ── FOOTER ──
    y += 62;
    doc.fontSize(7).font('Helvetica').fillColor(mid)
       .text('Columbine Copy & Apparel  ·  419 N. 1st Street, Montrose, CO 81401  ·  (970) 249-4418  ·  ColumbineCopy.com', 40, y, { width: W, align: 'center' })
       .text('All files are kept confidential and deleted after printing', 40, y + 10, { width: W, align: 'center' });

    doc.end();
  });
}

// ── Send email via Resend ─────────────────────────────────────────────────────
async function sendEmail(to, subject, html, attachments = []) {
  const payload = JSON.stringify({
    from: `Columbine Copy & Apparel <${process.env.OWNER_EMAIL}>`,
    to: [to],
    subject,
    html,
    attachments,
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

// ── Format cart item for email body ──────────────────────────────────────────
function formatCartItemEmail(item, index, driveLink) {
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
    item.bindType ? `<b>Binding:</b> ${item.bindType}` : '',
    item.lamination ? `<b>Lamination:</b> ${item.lamType || 'Yes'}` : '',
    item.holePunch ? `<b>Hole Punch:</b> Yes` : '',
    item.notes ? `<b>Notes:</b> ${item.notes}` : '',
    `<b>Item Total:</b> $${Number(item.price || 0).toFixed(2)}`,
    driveLink
      ? `<b>📁 Print File:</b> <a href="${driveLink.webViewLink}" style="color:#6b27b8">View on Google Drive →</a>`
      : `<b style="color:#cc0000">⚠ No file uploaded for this item</b>`,
  ].filter(Boolean);

  return `
    <div style="background:#f4f0fb;border:1px solid #d4c8e8;border-radius:6px;padding:14px 18px;margin-bottom:12px">
      <div style="font-weight:700;color:#1a0a2e;margin-bottom:8px">Item ${index + 1} — ${item.fileName || 'File'}</div>
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

  const finalAmount  = Math.max(Number(amountCents), 100);
  const totalAmount  = (finalAmount / 100).toFixed(2);
  const subtotalAmount = (finalAmount / 100 / 1.0853).toFixed(2);
  const taxAmount    = ((finalAmount / 100) - (finalAmount / 100 / 1.0853)).toFixed(2);
  const orderId      = 'CCA-' + Math.floor(100000 + Math.random() * 900000);
  const orderDate    = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' });

  // ── 1. Charge via Square ──────────────────────────────────────────────────
  const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
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

  // ── 2. Upload files to Google Drive ──────────────────────────────────────
  const driveLinks = [];
  let googleAccessToken = null;

  if (pdfFiles && pdfFiles.length > 0) {
    try {
      googleAccessToken = await getGoogleAccessToken();
      console.log('✅ Google auth successful');
    } catch(e) {
      console.error('Google auth failed:', e.message);
    }
  }

  for (let i = 0; i < (pdfFiles || []).length; i++) {
    const f = pdfFiles[i];
    if (!f || !f.data) { driveLinks.push(null); continue; }
    try {
      const clean = f.data.replace(/^data:[^;]+;base64,/, '');
      const driveName = `${orderId}_Item${i + 1}_${f.name || 'file.pdf'}`;
      const result = await uploadToGoogleDrive(googleAccessToken, driveName, clean);
      driveLinks.push(result);
      console.log(`✅ Uploaded to Drive: ${driveName} — ${result.webViewLink}`);
    } catch(e) {
      console.error(`Drive upload failed for item ${i + 1}:`, e.message);
      driveLinks.push(null);
    }
  }

  // Pad driveLinks to match cartItems length
  while (driveLinks.length < (cartItems || []).length) driveLinks.push(null);

  // ── 3. Build owner email body ─────────────────────────────────────────────
  const cartHtml = (cartItems || []).map((item, i) =>
    formatCartItemEmail(item, i, driveLinks[i])
  ).join('');

  const uploadedCount = driveLinks.filter(Boolean).length;
  const driveStatusHtml = uploadedCount > 0
    ? `<p style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;padding:12px;color:#2e7d32;font-size:.88rem">
        📁 ${uploadedCount} file${uploadedCount > 1 ? 's' : ''} uploaded to Google Drive — links included in order details below
       </p>`
    : `<p style="background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:12px;color:#e65100;font-size:.88rem">
        ⚠ No files were uploaded to Google Drive — customer may need to resend
       </p>`;

  // ── 4. Generate PDF job ticket (attached to owner email) ──────────────────
  let jobTicketBase64 = null;
  try {
    const jobTicketPDF = await generateJobTicketPDF(
      orderId, customer, cartItems, orderNotes,
      totalAmount, subtotalAmount, taxAmount,
      driveLinks, orderDate
    );
    jobTicketBase64 = jobTicketPDF.toString('base64');
    console.log('✅ Job ticket PDF generated');
  } catch(e) {
    console.error('Job ticket PDF error:', e.message);
  }

  // ── 5. Email owner ────────────────────────────────────────────────────────
  await sendEmail(
    process.env.OWNER_EMAIL,
    `🖨 New Print Order ${orderId} — $${totalAmount} — ${customer?.name}`,
    `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto">
      <div style="background:#1a0a2e;padding:24px;border-radius:6px 6px 0 0">
        <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">New Print Order</h1>
        <p style="color:#9a8ab0;margin:6px 0 0">Order ${orderId} &nbsp;·&nbsp; $${totalAmount} paid &nbsp;·&nbsp; ${orderDate}</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #d4c8e8;border-top:none">

        <h2 style="color:#1a0a2e;font-size:1rem;margin:0 0 10px">Customer</h2>
        <div style="background:#f4f0fb;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:.88rem">
          <div><b>Name:</b> ${customer?.name || '—'}</div>
          <div><b>Email:</b> ${customer?.email || '—'}</div>
          <div><b>Phone:</b> ${customer?.phone || '—'}</div>
          ${orderNotes ? `<div style="margin-top:6px"><b>Order Notes:</b> ${orderNotes}</div>` : ''}
        </div>

        ${driveStatusHtml}

        <h2 style="color:#1a0a2e;font-size:1rem;margin:16px 0 10px">Order Items</h2>
        ${cartHtml}

        <div style="background:#1a0a2e;border-radius:6px;padding:14px 18px;margin-top:16px">
          <div style="color:#9a8ab0;font-size:.78rem;margin-bottom:2px">Subtotal: $${subtotalAmount}</div>
          <div style="color:#9a8ab0;font-size:.78rem;margin-bottom:6px">Tax (8.53%): $${taxAmount}</div>
          <div style="color:#9a8ab0;font-size:.85rem;text-transform:uppercase;letter-spacing:1px">Total Paid</div>
          <div style="color:#c8a0f0;font-size:1.5rem;font-weight:700">$${totalAmount}</div>
        </div>

        <p style="color:#999;font-size:.78rem;margin-top:16px">
          Payment ID: ${payment.id}<br>
          📎 Job ticket attached — print and attach to order
        </p>
      </div>
    </div>`,
    jobTicketBase64 ? [{ filename: `JobTicket_${orderId}.pdf`, content: jobTicketBase64 }] : []
  );

  // ── 6. Email customer confirmation ────────────────────────────────────────
  if (customer?.email) {
    await sendEmail(
      customer.email,
      `Your print order is confirmed — ${orderId}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a0a2e;padding:24px;border-radius:6px 6px 0 0;text-align:center">
          <img src="https://print.columbinecopy.com/COLUMBINE-a.png" alt="Columbine Copy" style="height:60px;width:auto;margin-bottom:12px" onerror="this.style.display='none'">
          <h1 style="color:#c8a0f0;font-size:1.4rem;margin:0">Order Confirmed!</h1>
          <p style="color:#9a8ab0;margin:6px 0 0">Columbine Copy &amp; Apparel</p>
        </div>
        <div style="background:#fff;padding:28px;border:1px solid #d4c8e8;border-top:none;text-align:center">
          <p style="color:#333;font-size:1rem">Hi ${customer.name?.split(' ')[0] || 'there'},</p>
          <p style="color:#555;font-size:.9rem;margin-top:8px;line-height:1.6">
            Thank you for your order! We have received your payment and print files and will begin processing your job shortly.
          </p>

          <div style="background:#f4f0fb;border:1px solid #d4c8e8;border-radius:6px;padding:16px 24px;margin:20px auto;display:inline-block">
            <div style="color:#6e5a8a;font-size:.72rem;text-transform:uppercase;letter-spacing:2px;margin-bottom:4px">Order Reference</div>
            <div style="color:#1a0a2e;font-size:1.5rem;font-weight:700;font-family:monospace;letter-spacing:3px">${orderId}</div>
          </div>

          <div style="background:#f9f9f9;border-radius:6px;padding:16px;margin:0 0 20px;text-align:left;font-size:.85rem">
            <div style="font-weight:700;color:#1a0a2e;margin-bottom:8px">Order Summary</div>
            ${(cartItems || []).map((item, i) => `
              <div style="border-bottom:1px solid #eee;padding:6px 0;color:#444">
                <b>Item ${i+1}:</b> ${item.fileName || 'File'} — 
                ${item.copies} cop${item.copies > 1 ? 'ies' : 'y'} · 
                ${item.color === 'color' ? 'Color' : 'B&W'} · 
                ${item.paperSize?.toUpperCase() || ''} — 
                <b>$${Number(item.price || 0).toFixed(2)}</b>
              </div>`).join('')}
            <div style="margin-top:10px;text-align:right">
              <span style="color:#6e5a8a;font-size:.8rem">Subtotal: $${subtotalAmount} · Tax: $${taxAmount} · </span>
              <b style="color:#1a0a2e">Total: $${totalAmount}</b>
            </div>
          </div>

          <p style="color:#555;font-size:.88rem;line-height:1.6">
            Your order will be printed during normal business hours.<br>
            We'll notify you by email when it's ready for pickup — usually within <b>30–60 minutes</b>.
          </p>

          <div style="margin-top:20px;padding:14px;background:#f4f0fb;border-radius:6px;font-size:.82rem;color:#6e5a8a">
            📍 419 N 1st St, Montrose, CO 81401 &nbsp;·&nbsp; 📞 (970) 249-4418 &nbsp;·&nbsp; ✉ print@columbinecopy.com
          </div>

          <p style="color:#bbb;font-size:.72rem;margin-top:20px">
            All files are kept confidential and deleted after printing
          </p>
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
