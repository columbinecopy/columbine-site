// get-online-shipping-rate.js
// Public-facing Shippo rate quote for the online quote.html checkout.
// Separate from get-shipping-rates.js (the staff-PIN counter system) so the
// counter tool keeps its full carrier/service-level range untouched.
//
// This version:
//   - No PIN — protected by CORS (only Columbine's own sites can call it)
//   - Computes weight + box packing itself from cart contents (real garment
//     weights + the unit system), instead of taking weight/dims as input
//   - Filters to Ground / Ground Advantage / Priority only
//   - Real Shippo cost never reaches the browser — only the marked-up price

const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
const MARKUP_MULTIPLIER = 1.10; // 10% markup — same as the counter system

// ── CORS: only Columbine's own sites may call this function ─────────────────
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
    'Content-Type': 'application/json',
  };
}

// Fixed shop origin address — Columbine Copy & Apparel
const ORIGIN_ADDRESS = {
  name: "Columbine Copy & Apparel",
  street1: "419 N. 1st Street",
  city: "Montrose",
  state: "CO",
  zip: "81401",
  country: "US",
  phone: "9702494418",
  email: "print@columbinecopy.com",
};

// ── Real per-garment weights and box-count "units" (unit system is for box
//    packing only — actual Shippo weight always uses real lbs below) ────────
const GARMENT_WEIGHT_LB = { tee: 0.43, hoodie: 1.2, hat: 0.1875 };
const GARMENT_UNITS     = { tee: 1,    hoodie: 3,   hat: 1 };

const BOX_MEDIUM = { label: 'Medium', capacityUnits: 48, tareLb: 1.2, length: 20.5, width: 15.5, height: 13.5 };
const BOX_LARGE  = { label: 'Large',  capacityUnits: 72, tareLb: 2.2, length: 22,   width: 15.5, height: 16.5 };

// Only these carrier service levels are ever quoted online
const ALLOWED_KEYWORDS  = ['ground', 'priority'];
const EXCLUDED_KEYWORDS = ['express', 'overnight', 'next_day', '2day', '2_day', '3day', 'saver', 'international'];

function isAllowedServiceLevel(rate) {
  const combined = `${rate.servicelevel?.token || ''} ${rate.servicelevel?.name || ''}`.toLowerCase();
  const allowed = ALLOWED_KEYWORDS.some(k => combined.includes(k));
  const excluded = EXCLUDED_KEYWORDS.some(k => combined.includes(k));
  return allowed && !excluded;
}

// ── Greedily pack cart units into medium/large boxes ─────────────────────────
// Phase 1 approximation: each box's weight is its tare plus its share of
// units × the order's average weight-per-unit (garments aren't individually
// assigned to a specific box). Good enough for a shipping estimate; a future
// pass could bin-pack actual items if exact box contents ever matter.
function packBoxes(totalUnits, totalWeightLb) {
  if (totalUnits <= 0) return [];
  const avgWeightPerUnit = totalWeightLb / totalUnits;
  const boxes = [];
  let remaining = totalUnits;

  while (remaining > 0) {
    const useLarge = remaining > BOX_MEDIUM.capacityUnits;
    const box = useLarge ? BOX_LARGE : BOX_MEDIUM;
    const unitsInBox = Math.min(remaining, box.capacityUnits);
    boxes.push({
      ...box,
      unitsInBox,
      weightLb: Math.round((box.tareLb + unitsInBox * avgWeightPerUnit) * 100) / 100,
    });
    remaining -= box.capacityUnits;
  }
  return boxes;
}

async function quoteBox(box, addressTo) {
  const shipmentPayload = {
    address_from: ORIGIN_ADDRESS,
    address_to: addressTo,
    parcels: [{
      length: String(box.length),
      width: String(box.width),
      height: String(box.height),
      distance_unit: 'in',
      weight: String(box.weightLb),
      mass_unit: 'lb',
    }],
    async: false,
  };

  const res = await fetch('https://api.goshippo.com/shipments/', {
    method: 'POST',
    headers: {
      Authorization: `ShippoToken ${SHIPPO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(shipmentPayload),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Shippo shipment error:', data);
    throw new Error('Failed to fetch rates from Shippo.');
  }

  const eligible = (data.rates || [])
    .filter(r => r.amount)
    .filter(r => !addressTo.isPoBox || r.provider === 'USPS')
    .filter(isAllowedServiceLevel);

  if (eligible.length === 0) return null;

  // TEMP DEBUG: logs every eligible (Ground/Ground Advantage/Priority) rate
  // Shippo returned for this box, before markup, so you can confirm the
  // cheapest one is actually being picked. Check the function log in Netlify
  // after a test quote. Safe to remove once you've confirmed it.
  console.log(`Eligible rates for ${box.label} box (${box.weightLb} lb):`,
    eligible.map(r => `${r.provider} ${r.servicelevel?.name || r.servicelevel_token} — $${r.amount}`));

  const cheapest = eligible.reduce((a, b) => (parseFloat(a.amount) < parseFloat(b.amount) ? a : b));
  const markedUp = Math.round(parseFloat(cheapest.amount) * MARKUP_MULTIPLIER * 100) / 100;

  return {
    box: box.label,
    carrier: cheapest.provider,
    service: cheapest.servicelevel?.name || cheapest.servicelevel_token,
    estimatedDays: cheapest.estimated_days,
    price: markedUp,
  };
}

exports.handler = async (event) => {
  const cors = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed.' }) };
  if (!SHIPPO_API_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Shippo API key not configured on server.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid request body.' }) }; }

  const {
    destName, destStreet1, destCity, destState, destZip, destCompany,
    isPoBox, cartItems,
  } = body;

  if (!destStreet1 || !destCity || !destState || !destZip) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'A full shipping address is required.' }) };
  }
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Cart is empty.' }) };
  }

  // ── Compute real weight + unit count from cart contents ──────────────────
  let totalWeightLb = 0;
  let totalUnits = 0;
  for (const item of cartItems) {
    const perGarmentLb = GARMENT_WEIGHT_LB[item.type];
    const perGarmentUnits = GARMENT_UNITS[item.type];
    if (perGarmentLb == null || perGarmentUnits == null) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `Unknown garment type: ${item.type}` }) };
    }
    totalWeightLb += perGarmentLb * (item.totalQty || 0);
    totalUnits += perGarmentUnits * (item.totalQty || 0);
  }

  const boxes = packBoxes(totalUnits, totalWeightLb);
  if (boxes.length === 0) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Nothing to ship.' }) };
  }

  const addressTo = {
    name: destName || 'Customer',
    company: destCompany || '',
    street1: destStreet1,
    city: destCity,
    state: destState,
    zip: destZip,
    country: 'US',
    isPoBox: !!isPoBox,
  };

  try {
    const quotedBoxes = await Promise.all(boxes.map(b => quoteBox(b, addressTo)));

    if (quotedBoxes.some(q => q === null)) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ error: 'No eligible shipping rates found for this address. Please call the shop for a manual quote.', boxes: [] }),
      };
    }

    const totalPrice = Math.round(quotedBoxes.reduce((s, q) => s + q.price, 0) * 100) / 100;

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        totalPrice,
        boxCount: quotedBoxes.length,
        boxes: quotedBoxes, // per-box breakdown, handy for the work order / email
      }),
    };
  } catch (err) {
    console.error('get-online-shipping-rate error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Could not fetch shipping rates. Please try again.' }) };
  }
};
