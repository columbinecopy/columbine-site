// get-shipping-rates.js
// Fetches live shipping rates from Shippo and returns them with a 30% markup applied.
// Shippo's real cost is NEVER sent to the browser — only the marked-up price.

const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
const MARKUP_MULTIPLIER = 1.30; // 30% markup

// Fixed shop origin address — Columbine Copy & Apparel
const ORIGIN_ADDRESS = {
  name: "Columbine Copy & Apparel",
  street1: "419 N. 1st Street",
  city: "Montrose",
  state: "CO",
  zip: "81401",
  country: "US",
  phone: "9702494418",
};

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
    const {
      destZip,
      destStreet1, // optional, improves rate accuracy
      destCity,    // optional
      destState,   // optional
      weightLb,
      lengthIn,
      widthIn,
      heightIn,
    } = body;

    if (!destZip || !weightLb || !lengthIn || !widthIn || !heightIn) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required fields: destZip, weightLb, lengthIn, widthIn, heightIn",
        }),
      };
    }

    const addressTo = {
      name: body.destName || "Customer",
      street1: destStreet1 || "",
      city: destCity || "",
      state: destState || "",
      zip: destZip,
      country: "US",
    };

    const shipmentPayload = {
      address_from: ORIGIN_ADDRESS,
      address_to: addressTo,
      parcels: [
        {
          length: String(lengthIn),
          width: String(widthIn),
          height: String(heightIn),
          distance_unit: "in",
          weight: String(weightLb),
          mass_unit: "lb",
        },
      ],
      async: false,
    };

    const shippoResponse = await fetch("https://api.goshippo.com/shipments/", {
      method: "POST",
      headers: {
        Authorization: `ShippoToken ${SHIPPO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(shipmentPayload),
    });

    const shipmentData = await shippoResponse.json();

    if (!shippoResponse.ok) {
      console.error("Shippo shipment error:", shipmentData);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Failed to fetch rates from Shippo.", details: shipmentData }),
      };
    }

    const rates = shipmentData.rates || [];

    if (rates.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ shipmentId: shipmentData.object_id, rates: [] }),
      };
    }

    // Build customer-facing rate list — marked-up price only, real Shippo cost stays server-side
    const customerRates = rates
      .filter((r) => r.amount) // discard malformed entries
      .map((r) => {
        const realCost = parseFloat(r.amount);
        const markedUpPrice = Math.round(realCost * MARKUP_MULTIPLIER * 100) / 100;
        return {
          rateId: r.object_id, // needed to purchase this exact rate later
          carrier: r.provider,
          service: r.servicelevel?.name || r.servicelevel_token,
          estimatedDays: r.estimated_days,
          durationTerms: r.duration_terms,
          price: markedUpPrice.toFixed(2),
        };
      })
      .sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    return {
      statusCode: 200,
      body: JSON.stringify({
        shipmentId: shipmentData.object_id,
        rates: customerRates,
      }),
    };
  } catch (err) {
    console.error("get-shipping-rates error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error.", details: err.message }),
    };
  }
};
