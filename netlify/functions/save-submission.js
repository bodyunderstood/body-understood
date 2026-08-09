const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
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

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: "Invalid JSON" });
  }

  const {
    submissionId,
    draftKey,
    status = "draft",
    mobileNumber,
    email,
    preferredName,
    lastName,
    gender,
    ageRange,
    country,
    consentToAnonymizedUse,
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
            last_name: lastName,
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
            last_name: lastName || null,
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

