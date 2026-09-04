// save-customer-info.js
// Called when the customer taps "Submit" on the tablet form after entering
// their own return info and the recipient's info. No PIN — customer-facing.

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
    const body = JSON.parse(event.body);

    const required = [
      "senderName", "senderStreet1", "senderCity", "senderState", "senderZip",
      "senderEmail", "senderPhone",
      "recipientName", "recipientStreet1", "recipientCity", "recipientState", "recipientZip",
    ];
    const missing = required.filter((f) => !body[f] || !String(body[f]).trim());
    if (missing.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Missing required fields: ${missing.join(", ")}` }),
      };
    }

    const store = getSessionStore();

    const sessionData = {
      phase: "awaiting_rates",
      senderName: body.senderName,
      senderStreet1: body.senderStreet1,
      senderCity: body.senderCity,
      senderState: body.senderState,
      senderZip: body.senderZip,
      senderEmail: body.senderEmail,
      senderPhone: body.senderPhone,
      recipientName: body.recipientName,
      recipientCompany: body.recipientCompany || "",
      recipientStreet1: body.recipientStreet1,
      recipientCity: body.recipientCity,
      recipientState: body.recipientState,
      recipientZip: body.recipientZip,
      recipientIsPoBox: !!body.recipientIsPoBox,
      wantsInsurance: !!body.wantsInsurance,
      insuranceAmount: body.insuranceAmount || "",
      insuranceContent: body.insuranceContent || "",
      agreedToDisclaimer: !!body.agreedToDisclaimer,
      submittedAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.setJSON(SESSION_KEY, sessionData);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("save-customer-info error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error.", details: err.message }),
    };
  }
};
