// start-session.js
// Called when a customer taps "Start New Shipment" on the tablet.
// Resets any old session data and marks the session as awaiting their input.
// No PIN — this is the customer-facing side of the flow by design.

const { getStore } = require("@netlify/blobs");

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
    const store = getSessionStore();
    await store.setJSON(SESSION_KEY, {
      phase: "awaiting_customer_input",
      updatedAt: Date.now(),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("start-session error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error.", details: err.message }),
    };
  }
};
