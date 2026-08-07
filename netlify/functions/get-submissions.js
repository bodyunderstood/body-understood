// netlify/functions/get-submissions.js
//
// Called by the profile page once someone has clicked their magic
// link and is authenticated. Returns their submission history so the
// app can render it — never called with a raw identifier, only with
// a verified Supabase session token.
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
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Method not allowed" });
  }

  const authHeader = event.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "");

  if (!token) {
    return respond(401, { error: "Not signed in" });
  }

  try {
    // Verify the session token actually belongs to a real, currently
    // signed-in user before returning anything.
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return respond(401, { error: "Session expired or invalid" });
    }

    const authedPhone = userData.user.phone;

    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("mobile_number", authedPhone)
      .maybeSingle();

    if (!contact) {
      return respond(200, { submissions: [] });
    }

    const { data: submissions, error: subError } = await supabase
      .from("submissions")
      .select(
        "id, pose_description, media_mode, media_urls, status, created_at, submitted_at, delivered_at"
      )
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false });

    if (subError) throw subError;

    return respond(200, { submissions });
  } catch (err) {
    console.error(err);
    return respond(500, { error: "Something went wrong loading your reviews." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
