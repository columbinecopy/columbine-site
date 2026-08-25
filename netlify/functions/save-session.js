// save-session.js
// Writes the current customer + rate quote info to Netlify Blobs so the
// customer-facing display tablet can poll and show it. PIN-protected since
// it's called from the staff-side tool.

const { getStore } = require("@netlify/blobs");

const STAFF_PIN = process.env.STAFF_PIN;
const SESSION_KEY = "current-session";

function getSessionStore() {
  return getStore({
    name: "shipping-counter-sessions",
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body);

    if (!STAFF_PIN || body.pin !== STAFF_PIN) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized." }) };
    }

    const store = getSessionStore();

    const sessionData = {
      status: body.status || "quote", // "quote" | "completed"
      customerName: body.customerName || "",
      address: body.address || "",
      packageSummary: body.packageSummary || "",
      rates: body.rates || [],
      completedInfo: body.completedInfo || null, // { service, price, trackingNumber }
      updatedAt: Date.now(),
    };

    await store.setJSON(SESSION_KEY, sessionData);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("save-session error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error.", details: err.message }),
    };
  }
};
