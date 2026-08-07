// netlify/functions/get-upload-url.js
//
// Photos and videos are too large to send through a JSON POST to
// save-submission.js safely. Instead: the app asks THIS function for
// a short-lived signed upload URL, then uploads the file directly to
// Supabase Storage using that URL. This function never sees the file
// itself — only Supabase Storage does.
//
// Required Netlify environment variables (same as the other functions):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUCKET = "submissions";

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

  let draftKey, fileName;
  try {
    ({ draftKey, fileName } = JSON.parse(event.body));
  } catch {
    return respond(400, { error: "Invalid JSON" });
  }

  if (!draftKey || !fileName) {
    return respond(400, { error: "draftKey and fileName are required" });
  }

  // Namespace every file under its own draft folder, so nothing from one
  // person's submission can collide with another's — even before we know
  // who they are yet.
  const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const path = `${draftKey}/${Date.now()}-${safeName}`;

  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);

    if (error) throw error;

    return respond(200, {
      path,
      token: data.token,
      signedUrl: data.signedUrl,
    });
  } catch (err) {
    console.error(err);
    return respond(500, { error: "Could not create an upload link." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
