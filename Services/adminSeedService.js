const bcrypt = require('bcrypt');
const Admin = require('../Models/adminModel');
const { isDeliverableEmail } = require('./adminOtpRecipientService');

async function ensureDefaultAdmin() {
  let email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '').trim();
  const fullName = String(process.env.ADMIN_NAME || 'LeverageX Admin').trim();
  const smtpUser = String(process.env.SMTP_USER || '').trim().toLowerCase();

  if (!email || !password) {
    console.warn('⚠️ ADMIN_EMAIL and ADMIN_PASSWORD not set — default admin account was not created');
    return { created: false, reason: 'missing_env' };
  }

  if (!isDeliverableEmail(email)) {
    if (isDeliverableEmail(smtpUser)) {
      console.warn(
        `[Admin] ADMIN_EMAIL=${email} is not deliverable; seeding admin with SMTP_USER=${smtpUser} instead`
      );
      email = smtpUser;
    } else {
      console.warn(
        `[Admin] ADMIN_EMAIL=${email} is not deliverable and SMTP_USER is missing — ` +
          'admin OTP emails will fail until ADMIN_EMAIL is a real inbox'
      );
    }
  }

  const existing = await Admin.findOne({
    $or: [{ email }, { username }],
  });

  if (existing) {
    return { created: false, reason: 'exists' };
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  await Admin.create({
    email,
    username,
    password: hashedPassword,
    fullName,
  });

  console.log(`✅ Default admin account ready for ${email} (username: ${username})`);
  return { created: true };
}

module.exports = {
  ensureDefaultAdmin,
};
