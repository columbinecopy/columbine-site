// clear-session.js
// Resets the customer display back to its idle/welcome state. PIN-protected.

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
    const body = JSON.parse(event.body || "{}");

    if (!STAFF_PIN || body.pin !== STAFF_PIN) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized." }) };
    }

    const store = getSessionStore();
    await store.delete(SESSION_KEY);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("clear-session error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error.", details: err.message }),
    };
  }
};
