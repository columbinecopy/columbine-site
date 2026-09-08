// verify-portal-pin.js
// Checks the access code entered on the customer shipping portal.
// Separate from your staff PIN — this one's specific to the portal customer.

const PORTAL_PIN = process.env.PORTAL_PIN;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!PORTAL_PIN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Portal PIN not configured on server." }),
    };
  }

  try {
    const { pin } = JSON.parse(event.body);

    if (pin === PORTAL_PIN) {
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 401, body: JSON.stringify({ error: "Incorrect code." }) };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error." }),
    };
  }
};
