const Admin = require('../Models/adminModel');
const { isDeliverableEmail } = require('./adminOtpRecipientService');

/**
 * Keep admin login email aligned with ADMIN_EMAIL on Render when env is a real address.
 * Skips placeholders like admin@example.com so they never overwrite a real inbox.
 */
async function syncAdminEmailFromEnv() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();

  if (!email) {
    return { updated: false };
  }

  if (!isDeliverableEmail(email)) {
    console.warn(
      `[Admin] ADMIN_EMAIL=${email} is not deliverable — skipping email sync. ` +
        'Set ADMIN_EMAIL to a real Gmail inbox (e.g. the same as SMTP_USER).'
    );
    return { updated: false, reason: 'undeliverable_admin_email' };
  }

  const admin = await Admin.findOne({
    $or: [{ username }, { email }],
  });

  if (!admin) {
    return { updated: false, reason: 'no_admin' };
  }

  if (admin.email === email) {
    return { updated: false, reason: 'already_synced' };
  }

  const conflict = await Admin.findOne({ email, _id: { $ne: admin._id } });
  if (conflict) {
    console.warn(
      `[Admin] ADMIN_EMAIL ${email} belongs to another admin — skipping email sync`
    );
    return { updated: false, reason: 'email_conflict' };
  }

  admin.email = email;
  await admin.save();
  console.log(`[Admin] Synced admin email to ADMIN_EMAIL: ${email}`);
  return { updated: true, email };
}

module.exports = {
  syncAdminEmailFromEnv,
};
