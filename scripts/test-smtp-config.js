/**
 * Unit-style check: invalid SMTP_SERVICE must not resolve to localhost.
 * Usage: node scripts/test-smtp-config.js
 */
const path = require('path');
const assert = require('assert');

// Isolate from real .env so we control SMTP_SERVICE for the regression case.
process.env.SMTP_USER = 'leveragexfund@gmail.com';
process.env.SMTP_PASS = 'fake-app-password-for-config-test';
process.env.EMAIL_FROM = 'leveragexfund@gmail.com';
delete process.env.SMTP_HOST;

// Load after env is set — emailService reads env at call time, so this is fine.
const emailServicePath = path.join(__dirname, '..', 'Services', 'emailService.js');

function loadFresh() {
  delete require.cache[require.resolve(emailServicePath)];
  // Re-require isn't enough to re-export internals; exercise via verify/send paths
  // by inspecting createTransport options through a local copy of the logic.
}

// Mirror the critical selection logic expectations using nodemailer well-known.
const wellKnown = require('nodemailer/lib/well-known');

assert.strictEqual(wellKnown('gmail').host, 'smtp.gmail.com');
assert.strictEqual(wellKnown('leveraged'), false);
assert.strictEqual(wellKnown('LEVERAGED'), false);
assert.strictEqual(wellKnown('leveragex'), false);

process.env.SMTP_SERVICE = 'LEVERAGED';
loadFresh();

const { verifySmtpOnStartup, sendEmail } = require('../Services/emailService');

async function main() {
  // verifySmtpOnStartup should attempt Gmail hosts, not 127.0.0.1.
  // We can't assert hosts directly; instead assert the failure message is NOT ECONNREFUSED 127.0.0.1
  // when network to gmail is available — or if auth fails, that proves we reached Gmail.
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => {
    logs.push(args.join(' '));
    origLog(...args);
  };
  console.error = (...args) => {
    errors.push(args.join(' '));
    origErr(...args);
  };

  try {
    await verifySmtpOnStartup();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  const all = [...logs, ...errors].join('\n');
  assert(
    !/ECONNREFUSED 127\.0\.0\.1/.test(all),
    'SMTP must not attempt localhost when SMTP_SERVICE is an invalid product name'
  );
  assert(
    /Falling back to Gmail SMTP|smtp\.gmail\.com|service=gmail/i.test(all),
    'Expected Gmail fallback logging for invalid SMTP_SERVICE'
  );

  // sendEmail should also avoid localhost (auth may fail with fake password — that's OK)
  const result = await sendEmail({
    to: 'leveragexfund@gmail.com',
    subject: 'config test',
    text: 'config test',
  });
  assert.strictEqual(result.skipped, undefined);
  if (!result.ok) {
    assert(
      !/ECONNREFUSED 127\.0\.0\.1/.test(String(result.error || '')),
      `Send error should not be localhost: ${result.error}`
    );
  }

  console.log('PASS — invalid SMTP_SERVICE falls back to Gmail (no localhost)');
}

main().catch((err) => {
  console.error('FAIL —', err);
  process.exit(1);
});
