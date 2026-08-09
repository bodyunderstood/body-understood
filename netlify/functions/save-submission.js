// netlify/functions/save-submission.js
//
// This function is the ONLY thing allowed to talk to Supabase with
// real write access. The app itself never sees the service_role key â€”
// it just calls this function, and this function does the writing.
//
// Saving starts from step one, before anyone has given a phone/email â€”
// every attempt gets a random draftKey the moment someone starts, and
// that's what identifies "this person's in-progress submission" until
// they reach the delivery step and give a real identifier. From that
// point on, the row also gets linked to a contact.
//
// Required Netlify environment variables (set in Netlify's dashboard,
// NEVER in this file, NEVER committed to code):
//   SUPABASE_URL          -> your Project URL (Settings -> API)
//   SUPABASE_SERVICE_KEY  -> your service_role key (Settings -> API Keys)

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
  // Browsers send a pre-flight OPTIONS request before the real POST
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: "Invalid JSON" });
  }

  const {
    submissionId, // null on first save, then the same id on every later save
    draftKey, // always present â€” identifies the attempt before identity exists
    status = "draft", // "draft" | "submitted"

    // identity â€” optional early on, required by the time status is "submitted"
    mobileNumber,
    email,
    preferredName,

    // demographics
    gender,
    ageRange,
    country,
    consentToAnonymizedUse,

    // submission fields
    poseDescription,
    mediaMode,
    sideMode,
    mediaUrls,
    motivations,
    otherReason,
    experienceLevel,
    healthFlags,
    healthContext,
  } = payload;

  if (!draftKey) {
    return respond(400, { error: "draftKey is required" });
  }
  if (status === "submitted" && !mobileNumber && !email) {
    return respond(400, { error: "mobileNumber or email is required to submit" });
  }

  try {
    // 1. Find or create the contact â€” only once we actually have an identifier
    let contactId = null;

    if (mobileNumber || email) {
      const identifierColumn = mobileNumber ? "mobile_number" : "email";
      const identifierValue = mobileNumber || email;

      let { data: existingContact } = await supabase
        .from("contacts")
        .select("id")
        .eq(identifierColumn, identifierValue)
        .maybeSingle();

      if (existingContact) {
        contactId = existingContact.id;
        await supabase
          .from("contacts")
          .update({
            preferred_name: preferredName,
            gender,
            age_range: ageRange,
            country,
            consent_to_anonymized_use: consentToAnonymizedUse,
            ...(mobileNumber ? { mobile_number: mobileNumber } : {}),
            ...(email ? { email } : {}),
          })
          .eq("id", contactId);
      } else {
        const { data: newContact, error: contactError } = await supabase
          .from("contacts")
          .insert({
            mobile_number: mobileNumber || null,
            email: email || null,
            preferred_name: preferredName || null,
            gender: gender || null,
            age_range: ageRange || null,
            country: country || null,
            consent_to_anonymized_use: consentToAnonymizedUse || false,
          })
          .select("id")
          .single();

        if (contactError) throw contactError;
        contactId = newContact.id;
      }
    }

    // 2. Find the existing submission â€” by id if we have one, otherwise by
    //    draftKey (covers the case where an earlier response never made it
    //    back to the browser, so it doesn't have a submissionId yet)
    let existingSubmissionId = submissionId;
    if (!existingSubmissionId) {
      const { data: existingByDraft } = await supabase
        .from("submissions")
        .select("id")
        .eq("draft_key", draftKey)
        .maybeSingle();
      if (existingByDraft) existingSubmissionId = existingByDraft.id;
    }

    const submissionRow = {
      draft_key: draftKey,
      ...(contactId ? { contact_id: contactId } : {}),
      pose_description: poseDescription || null,
      media_mode: mediaMode || null,
      side_mode: sideMode || null,
      media_urls: mediaUrls || [],
      motivations: motivations || [],
      other_reason: otherReason || null,
      experience_level: experienceLevel || null,
      health_flags: healthFlags || [],
      health_context: healthContext || null,
      status,
      ...(status === "submitted" ? { submitted_at: new Date().toISOString() } : {}),
    };

    let savedSubmissionId = existingSubmissionId;

    if (existingSubmissionId) {
      const { error: updateError } = await supabase
        .from("submissions")
        .update(submissionRow)
        .eq("id", existingSubmissionId);
      if (updateError) throw updateError;
    } else {
      const { data: newSubmission, error: insertError } = await supabase
        .from("submissions")
        .insert(submissionRow)
        .select("id")
        .single();
      if (insertError) throw insertError;
      savedSubmissionId = newSubmission.id;
    }

    // 3. On a real submit, trigger the notification directly â€” this
    // replaces Supabase's Database Webhooks feature, which has a known
    // platform bug ("schema supabase_functions does not exist") that
    // blocks webhook creation on some projects. Calling the sibling
    // function directly sidesteps that entirely, since it's just one
    // Netlify function calling another on the same site.
    //
    // This MUST be awaited â€” serverless functions can be frozen the
    // instant they return a response, so an un-awaited "fire and
    // forget" call here would often never actually complete.
    if (status === "submitted") {
      const siteUrl = process.env.URL || "https://bodyunderstood.app";
      try {
        await fetch(`${siteUrl}/.netlify/functions/notify-new-submission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            record: { ...submissionRow, id: savedSubmissionId, contact_id: contactId },
            old_record: { status: "draft" },
          }),
        });
      } catch (err) {
        // Never let a notification failure affect the actual submission â€”
        // the row is already safely saved either way.
        console.error("Notification call failed:", err);
      }
    }

    return respond(200, { submissionId: savedSubmissionId, contactId });
  } catch (err) {
    console.error(err);
    return respond(500, { error: "Something went wrong saving your submission." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
