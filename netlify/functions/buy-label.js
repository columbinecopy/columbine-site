// buy-label.js
// Purchases the actual shipping label from Shippo for a previously-quoted rate.
// The rateId must come from a rate returned by get-shipping-rates.js.

const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!SHIPPO_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Shippo API key not configured on server." }),
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { rateId } = body;

    if (!rateId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required field: rateId" }),
      };
    }

    const transactionPayload = {
      rate: rateId,
      label_file_type: "PDF_4x6", // matches your PM-241-BT 4x6 labels
      async: false,
    };

    const shippoResponse = await fetch("https://api.goshippo.com/transactions/", {
      method: "POST",
      headers: {
        Authorization: `ShippoToken ${SHIPPO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transactionPayload),
    });

    const txData = await shippoResponse.json();

    if (!shippoResponse.ok || txData.status !== "SUCCESS") {
      console.error("Shippo transaction error:", txData);
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "Failed to purchase label.",
          details: txData.messages || txData,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        labelUrl: txData.label_url,       // PDF to open/print via Labelife
        trackingNumber: txData.tracking_number,
        trackingUrl: txData.tracking_url_provider,
        carrier: txData.rate?.provider,
      }),
    };
  } catch (err) {
    console.error("buy-label error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error.", details: err.message }),
    };
  }
};
