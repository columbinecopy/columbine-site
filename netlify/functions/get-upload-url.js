/**
 * Columbine Copy & Apparel — Google Drive Upload URL Generator
 * 
 * This function generates a secure resumable upload URL for Google Drive.
 * The browser uses this URL to upload files directly to Google Drive
 * without going through Netlify (bypassing the 6MB request limit).
 *
 * Flow:
 *   1. Browser calls this function with filename + mimeType
 *   2. This function authenticates with Google using the service account
 *   3. Returns a one-time resumable upload URL to the browser
 *   4. Browser uploads the file directly to Google Drive using that URL
 *   5. Google Drive returns the file ID to the browser
 *   6. Browser sends file ID (not file data) to create-payment function
 */

const https = require('https');
const { createSign } = require('crypto');

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch(e) { parsed = text; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : body);
    req.end();
  });
}

// ── Get Google access token using domain-wide delegation ──────────────────────
async function getGoogleAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const impersonateEmail = process.env.OWNER_EMAIL;
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: impersonateEmail,
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

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  // CORS headers for browser requests
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { fileName, mimeType = 'application/pdf', orderId } = body;

  if (!fileName) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'fileName is required' }) };
  }

  try {
    // Get Google access token
    const accessToken = await getGoogleAccessToken();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    // Build the file name with order ID prefix
    const driveName = orderId ? `${orderId}_${fileName}` : fileName;

    // Create a resumable upload session
    const metadata = JSON.stringify({
      name: driveName,
      parents: folderId ? [folderId] : [],
    });

    const initResult = await httpsRequest({
      hostname: 'www.googleapis.com',
      path: `/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(metadata),
        'X-Upload-Content-Type': mimeType,
      },
    }, metadata);

    if (initResult.status !== 200) {
      throw new Error('Failed to create upload session: ' + JSON.stringify(initResult.body));
    }

    // The resumable upload URL is in the Location header
    const uploadUrl = initResult.headers.location;

    if (!uploadUrl) {
      throw new Error('No upload URL returned from Google');
    }

    console.log(`✅ Upload URL generated for: ${driveName}`);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadUrl, fileName: driveName }),
    };

  } catch(e) {
    console.error('get-upload-url error:', e.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
