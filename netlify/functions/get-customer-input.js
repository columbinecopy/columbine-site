// get-customer-input.js
// Staff-side polling endpoint — picks up whatever the customer has submitted
// on the tablet so it can auto-fill the iPad's form. PIN-protected since
// it's read by the staff tool.

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
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const pin = event.queryStringParameters && event.queryStringParameters.pin;
  if (!STAFF_PIN || pin !== STAFF_PIN) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized." }) };
  }

  try {
    const store = getSessionStore();
    const session = await store.get(SESSION_KEY, { type: "json" });

    if (!session || session.phase !== "awaiting_rates") {
      return { statusCode: 200, body: JSON.stringify({ available: false }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ available: true, ...session }),
    };
  } catch (err) {
    console.error("get-customer-input error:", err);
    return { statusCode: 200, body: JSON.stringify({ available: false }) };
  }
};
