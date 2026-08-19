// verify-pin.js
// Checks the staff PIN entered on the counter page against the server-side value.
// This is a lightweight access gate, not full authentication — it exists to stop
// randoms who stumble on the URL from buying real labels on your Shippo account.

const STAFF_PIN = process.env.STAFF_PIN;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!STAFF_PIN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Staff PIN not configured on server." }),
    };
  }

  try {
    const { pin } = JSON.parse(event.body);

    if (pin === STAFF_PIN) {
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 401, body: JSON.stringify({ error: "Incorrect PIN." }) };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error." }),
    };
  }
};
