// portal-email-label.js
// Fetches the purchased label PDF and emails it as an attachment via Resend.
// Used by the "Email me a copy" option on the results screen.

const https = require('https');

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

  const { pin, labelUrl, customerEmail, orderId } = body;

  if (!PORTAL_PIN || pin !== PORTAL_PIN) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorized.' }) };
  }
  if (!labelUrl || !customerEmail) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing label URL or email address.' }) };
  }

  try {
    // Fetch the actual PDF bytes so we can attach them directly
    const pdfResponse = await fetch(labelUrl);
    if (!pdfResponse.ok) {
      throw new Error('Could not fetch label PDF, status ' + pdfResponse.status);
    }
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    const pdfBase64 = pdfBuffer.toString('base64');

    const emailData = {
      from: `Columbine Copy & Apparel <${process.env.OWNER_EMAIL}>`,
      to: [customerEmail],
      subject: `Your shipping label — ${orderId || ''}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <p>Attached is your shipping label. Print it at actual size (no scaling) for the best fit on 4x6 label stock.</p>
        <p style="color:#999;font-size:.78rem;margin-top:24px">Columbine Copy & Apparel · 419 N. 1st Street, Montrose, CO</p>
      </div>`,
      attachments: [
        { filename: 'shipping-label.pdf', content: pdfBase64 },
      ],
    };
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
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Could not send the email. Please try downloading instead.' }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('portal-email-label error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Internal server error.' }) };
  }
};
