/**
 * Columbine Copy & Apparel — Railway Express Server
 * Wraps the payment function in an Express server for Railway hosting
 */

const express = require('express');
const path = require('path');
const { handler: createPaymentHandler } = require('./netlify/functions/create-payment');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies — increase limit for PDF file uploads
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// CORS headers for browser requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files (logo, etc.)
app.use(express.static(path.join(__dirname)));

// ── Payment endpoint ──────────────────────────────────────────────────────────
app.post('/api/create-payment', async (req, res) => {
  try {
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify(req.body),
      headers: req.headers,
    };
    const result = await createPaymentHandler(event);
    res.status(result.statusCode).json(JSON.parse(result.body));
  } catch (err) {
    console.error('Payment handler error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`✅ Columbine Copy server running on port ${PORT}`);
});
