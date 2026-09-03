// get-shipping-rates.js
// Fetches live shipping rates from Shippo and returns them with a 30% markup applied.
// Shippo's real cost is NEVER sent to the browser — only the marked-up price.

const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
const STAFF_PIN = process.env.STAFF_PIN;
const MARKUP_MULTIPLIER = 1.30; // 30% markup

// Note: as of the return-address change, the customer's own info is used as
// address_from (so failed deliveries route back to them, not the shop) —
// this is no longer a fixed shop constant, it comes in on every request.

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

    if (!STAFF_PIN || body.pin !== STAFF_PIN) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized." }) };
    }

    const {
      // Sender / return address — now the customer's own info, not the shop's
      senderName,
      senderStreet1,
      senderCity,
      senderState,
      senderZip,
      senderEmail,
      senderPhone,
      // Recipient / ship-to
      destZip,
      destStreet1, // optional, improves rate accuracy
      destCity,    // optional
      destState,   // optional
      destCompany, // optional
      isPoBox,     // boolean — when true, only USPS rates are returned
      refNumber,   // optional — prints on the label (RA#, PO#, etc.)
      insuranceAmount, // optional — declared value to insure via Shippo/XCover
      insuranceContent, // optional — description of package contents, required if insuring
      weightLb,
      weightUnit,  // "lb" or "oz"
      lengthIn,
      widthIn,
      heightIn,
    } = body;

    if (!senderName || !senderStreet1 || !senderCity || !senderState || !senderZip || !senderEmail || !senderPhone) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required sender (return address) fields.",
        }),
      };
    }

    if (!destZip || !destStreet1 || !destCity || !destState || !weightLb || !lengthIn || !widthIn || !heightIn) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required fields: full address, weight, and box dimensions are all required.",
        }),
      };
    }

    const addressFrom = {
      name: senderName,
      street1: senderStreet1,
      city: senderCity,
      state: senderState,
      zip: senderZip,
      country: "US",
      email: senderEmail, // required by USPS for label purchase
      phone: senderPhone,
    };

    const addressTo = {
      name: body.destName || "Customer",
      company: destCompany || "",
      street1: destStreet1 || "",
      city: destCity || "",
      state: destState || "",
      zip: destZip,
      country: "US",
    };

    const shipmentPayload = {
      address_from: addressFrom,
      address_to: addressTo,
      parcels: [
        {
          length: String(lengthIn),
          width: String(widthIn),
          height: String(heightIn),
          distance_unit: "in",
          weight: String(weightLb),
          mass_unit: weightUnit === "oz" ? "oz" : "lb", // defaults to lb if not specified
        },
      ],
      async: false,
    };

    // Optional reference number (e.g. a return authorization #) — prints
    // directly on supported carrier labels (USPS prints it at the bottom).
    // Optional insurance — Shippo/XCover coverage, cost is already folded
    // into each rate's "amount" by Shippo, so our markup below covers it too.
    const extra = {};
    if (refNumber) extra.reference_1 = refNumber;
    if (insuranceAmount && insuranceContent) {
      extra.insurance = {
        amount: String(insuranceAmount),
        currency: "USD",
        content: insuranceContent,
      };
    }
    if (Object.keys(extra).length > 0) {
      shipmentPayload.extra = extra;
      console.log("Insurance/extra requested:", JSON.stringify(extra));
    }

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

    if (extra.insurance && rates.length > 0) {
      console.log("Sample rate insurance field from Shippo:", JSON.stringify({
        provider: rates[0].provider,
        amount: rates[0].amount,
        included_insurance_price: rates[0].included_insurance_price,
      }));
    }

    if (rates.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ shipmentId: shipmentData.object_id, rates: [] }),
      };
    }

    const uspsOnlyNote = isPoBox
      ? " (P.O. Box selected — only USPS delivers to PO Boxes, so only USPS options are shown.)"
      : "";

    // Build customer-facing rate list — marked-up price only, real Shippo cost stays server-side
    const customerRates = rates
      .filter((r) => r.amount) // discard malformed entries
      .filter((r) => !isPoBox || r.provider === "USPS") // UPS/FedEx/DHL don't deliver to PO Boxes
      .map((r) => {
        const realCost = parseFloat(r.amount);
        const markedUpPrice = Math.round(realCost * MARKUP_MULTIPLIER * 100) / 100;
        const insuranceIncluded = r.included_insurance_price
          ? (Math.round(parseFloat(r.included_insurance_price) * MARKUP_MULTIPLIER * 100) / 100).toFixed(2)
          : null;
        return {
          rateId: r.object_id, // needed to purchase this exact rate later
          carrier: r.provider,
          service: r.servicelevel?.name || r.servicelevel_token,
          estimatedDays: r.estimated_days,
          durationTerms: r.duration_terms,
          price: markedUpPrice.toFixed(2),
          insuranceIncluded, // marked-up insurance cost, already folded into price above
        };
      })
      .sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    return {
      statusCode: 200,
      body: JSON.stringify({
        shipmentId: shipmentData.object_id,
        rates: customerRates,
        note: uspsOnlyNote,
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
