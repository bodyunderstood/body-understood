// netlify/functions/notify-new-submission.js
//
// Called automatically by a Supabase Database Webhook the moment a
// submission's status changes to "submitted". Sends Lisa an email with
// the person's name, what they submitted, and a direct link into
// Supabase to go watch it — so nothing sits unnoticed in a table.
//
// One-time setup needed (see the instructions that come with this file):
//   1. A free Resend account (resend.com) for sending the email
//   2. A Supabase Database Webhook pointing at this function
//
// Required Netlify environment variables:
//   SUPABASE_URL          -> same as the other functions
//   SUPABASE_SERVICE_KEY  -> same as the other functions
//   RESEND_API_KEY        -> from your Resend account
//   NOTIFY_EMAIL          -> the inbox that should receive these emails
//   SUPABASE_PROJECT_ID   -> the short ID in your Supabase project URL
//                            (e.g. "cfksdceximniimmeapyy")

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const record = payload.record;
  const oldRecord = payload.old_record;

  // Only notify on the moment something BECOMES submitted — not on every
  // later edit (e.g. when Lisa marks it "reviewed" or "sent" afterward)
  if (!record || record.status !== "submitted" || oldRecord?.status === "submitted") {
    return { statusCode: 200, body: "No notification needed" };
  }

  try {
    // Look up the person's name and contact details for the email itself
    let contactLine = "Someone";
    if (record.contact_id) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("preferred_name, mobile_number, email")
        .eq("id", record.contact_id)
        .maybeSingle();

      if (contact) {
        const name = contact.preferred_name || "Someone";
        const via = contact.mobile_number || contact.email || "";
        contactLine = via ? `${name} (${via})` : name;
      }
    }

    const tableLink = `https://supabase.com/dashboard/project/${process.env.SUPABASE_PROJECT_ID}/editor`;

    const emailBody = `
      <p><strong>${contactLine}</strong> just submitted a movement review.</p>
      <p><strong>Pose:</strong> ${record.pose_description || "Not described"}</p>
      <p><strong>Type:</strong> ${record.media_mode || "—"}</p>
      ${record.health_context ? `<p><strong>Context they shared:</strong> ${record.health_context}</p>` : ""}
      <p><a href="${tableLink}">Open in Supabase to review →</a></p>
    `;

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Body, Understood. <onboarding@resend.dev>", // swap to your own domain once verified in Resend
        to: process.env.NOTIFY_EMAIL,
        subject: `New review submitted — ${contactLine}`,
        html: emailBody,
      }),
    });

    if (!resendResponse.ok) {
      const errText = await resendResponse.text();
      throw new Error(`Resend failed: ${errText}`);
    }

    return { statusCode: 200, body: "Notification sent" };
  } catch (err) {
    console.error(err);
    // A failed notification shouldn't break the submission itself —
    // the row is already saved either way, this is just the alert.
    return { statusCode: 500, body: "Notification failed, but submission is safe" };
  }
};
