// get-session.js
// Read-only endpoint the customer-facing display tablet polls every couple
// seconds. Intentionally no PIN — the display page itself has no login,
// by design, to keep it simple for customers to view.

const { getStore } = require("@netlify/blobs");

const SESSION_KEY = "current-session";
const STALE_MS = 10 * 60 * 1000; // treat sessions older than 10 min as stale

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const store = getStore("shipping-counter-sessions");
    const session = await store.get(SESSION_KEY, { type: "json" });

    if (!session || Date.now() - session.updatedAt > STALE_MS) {
      return { statusCode: 200, body: JSON.stringify({ active: false }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ active: true, ...session }),
    };
  } catch (err) {
    console.error("get-session error:", err);
    return { statusCode: 200, body: JSON.stringify({ active: false }) };
  }
};
