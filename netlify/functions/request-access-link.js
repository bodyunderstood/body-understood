// netlify/functions/request-access-link.js
//
// Sends a one-time SMS code to sign someone in — no password, no
// account creation. Every contact has a mobile number (it's the only
// delivery method the app collects), so this is always straightforward.
//
// One-time setup in Supabase dashboard:
//   Authentication -> Providers -> enable "Phone"
//   (needs a Twilio account connected on that same page)
//
// Required Netlify environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your real domain once live
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  let mobileNumber;
  try {
    ({ mobileNumber } = JSON.parse(event.body));
  } catch {
    return respond(400, { error: "Invalid JSON" });
  }

  if (!mobileNumber || !mobileNumber.trim()) {
    return respond(400, { error: "mobileNumber is required" });
  }

  const trimmed = mobileNumber.trim();

  try {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("mobile_number", trimmed)
      .maybeSingle();

    if (!contact) {
      // Deliberately vague — don't reveal whether this number has submitted before.
      return respond(200, { ok: true });
    }

    const { error } = await supabase.auth.signInWithOtp({ phone: trimmed });
    if (error) throw error;

    return respond(200, { ok: true });
  } catch (err) {
    console.error(err);
    return respond(500, { error: "Something went wrong sending your code." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
