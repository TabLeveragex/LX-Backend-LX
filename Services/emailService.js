const nodemailer = require('nodemailer');
const dns = require('dns');

// Render/cloud hosts often hang on IPv6 → smtp.gmail.com; prefer IPv4.
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Older Node versions may not support this; family:4 on transports still helps.
}

function normalizeEnvValue(value) {
  let v = String(value || '').trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function normalizeSmtpPass(pass) {
  return normalizeEnvValue(pass).replace(/\s+/g, '');
}

function getSmtpUser() {
  return normalizeEnvValue(process.env.SMTP_USER).toLowerCase();
}

function getSmtpPass() {
  const primary = normalizeSmtpPass(process.env.SMTP_PASS);
  if (primary) {
    return primary;
  }
  return normalizeSmtpPass(process.env.SMTP_PASSWORD);
}

function isEmailConfigured() {
  return Boolean(getSmtpUser() && getSmtpPass());
}

function describeTransportOptions(options) {
  if (options.service) {
    return `service=${options.service}`;
  }
  return `host=${options.host} port=${options.port} secure=${options.secure}`;
}

const SMTP_TIMEOUTS = {
  connectionTimeout: 8_000,
  greetingTimeout: 8_000,
  socketTimeout: 15_000,
  // Force IPv4 — avoids ~30s IPv6 hangs to smtp.gmail.com on some hosts (e.g. Render).
  family: 4,
  tls: { servername: 'smtp.gmail.com', minVersion: 'TLSv1.2' },
};

function getCustomHostTransportOptions(user, pass) {
  const host = normalizeEnvValue(process.env.SMTP_HOST);
  if (!host) {
    return [];
  }

  return [
    {
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: { user, pass },
      connectionTimeout: SMTP_TIMEOUTS.connectionTimeout,
      greetingTimeout: SMTP_TIMEOUTS.greetingTimeout,
      socketTimeout: SMTP_TIMEOUTS.socketTimeout,
      family: 4,
    },
  ];
}

function getGmailTransportOptions(user, pass) {
  // Prefer STARTTLS:587 first (fast path). Keep 465 as fallback only.
  return [
    {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user, pass },
      ...SMTP_TIMEOUTS,
    },
    {
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
      ...SMTP_TIMEOUTS,
    },
  ];
}

function isGmailMailbox(user) {
  return user.endsWith('@gmail.com') || user.endsWith('@googlemail.com');
}

function isGmailServiceName(service) {
  return service === 'gmail' || service === 'google' || service === 'googlemail';
}

/**
 * Resolve SMTP transports. Unknown SMTP_SERVICE values (e.g. product names like
 * "LEVERAGED") are not nodemailer well-known services and cause connections to
 * 127.0.0.1:587 — fall back to Gmail when the mailbox is Gmail.
 */
function getTransportOptionsList(user, pass) {
  const custom = getCustomHostTransportOptions(user, pass);
  if (custom.length) {
    return custom;
  }

  const service = normalizeEnvValue(process.env.SMTP_SERVICE).toLowerCase() || 'gmail';
  if (isGmailServiceName(service)) {
    return getGmailTransportOptions(user, pass);
  }

  let wellKnown = null;
  try {
    wellKnown = require('nodemailer/lib/well-known')(service);
  } catch {
    wellKnown = null;
  }

  if (!wellKnown) {
    if (isGmailMailbox(user)) {
      console.warn(
        `[Email] SMTP_SERVICE="${service}" is not a valid nodemailer service ` +
          `(unknown names resolve to 127.0.0.1:587). Falling back to Gmail SMTP for ${user}. ` +
          `Set SMTP_SERVICE=gmail in .env / Render.`
      );
      return getGmailTransportOptions(user, pass);
    }

    console.error(
      `[Email] SMTP_SERVICE="${service}" is not a valid nodemailer well-known service. ` +
        `Set SMTP_SERVICE=gmail or configure SMTP_HOST / SMTP_PORT.`
    );
    return getGmailTransportOptions(user, pass);
  }

  return [
    { service, auth: { user, pass }, ...SMTP_TIMEOUTS },
    ...(isGmailMailbox(user) ? getGmailTransportOptions(user, pass) : []),
  ];
}

function buildFromAddress() {
  const smtpUser = getSmtpUser();
  const fromEnv = normalizeEnvValue(process.env.EMAIL_FROM).toLowerCase();
  const fromEmail = fromEnv || smtpUser;
  if (!fromEmail) {
    return '';
  }
  if (fromEmail !== smtpUser && smtpUser) {
    console.warn(
      `[Email] EMAIL_FROM (${fromEmail}) differs from SMTP_USER (${smtpUser}); using SMTP_USER as From for Gmail compatibility.`
    );
    return smtpUser;
  }
  return fromEmail;
}

/**
 * Map SMTP failures to a stable kind + operator-facing hint for logs/API messages.
 */
function classifySmtpFailure(error, responseCode) {
  const msg = String(error?.message || error || '');
  const code = responseCode || error?.responseCode;

  if (code === 535 || /BadCredentials|Username and Password not accepted/i.test(msg)) {
    return {
      kind: 'auth',
      hint:
        'Gmail rejected SMTP_USER/SMTP_PASS. Create a new App Password at ' +
        'https://myaccount.google.com/apppasswords (2FA required), set SMTP_PASS on Render, redeploy.',
    };
  }

  if (/ECONNREFUSED 127\.0\.0\.1/i.test(msg)) {
    return {
      kind: 'misconfigured_service',
      hint:
        'SMTP_SERVICE is not a valid nodemailer service (unknown names hit 127.0.0.1). Set SMTP_SERVICE=gmail.',
    };
  }

  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNECTION|Timeout|timeout|ESOCKET/i.test(msg)) {
    return {
      kind: 'network',
      hint:
        'Could not reach the SMTP host in time (common on Render with IPv6). ' +
        'App forces IPv4; confirm SMTP_SERVICE=gmail and SMTP_PASS, then redeploy.',
    };
  }

  return {
    kind: 'send_failed',
    hint: 'SMTP send failed. Check server logs for the transport error and response code.',
  };
}

async function verifyTransport(options) {
  const transporter = nodemailer.createTransport(options);
  await transporter.verify();
}

async function sendWithFallbackTransports(mailOptions) {
  const user = getSmtpUser();
  const pass = getSmtpPass();
  const transports = getTransportOptionsList(user, pass);
  let lastError = null;

  for (const options of transports) {
    const label = describeTransportOptions(options);
    const transporter = nodemailer.createTransport(options);
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`[Email] Sent via ${label} to ${mailOptions.to}`);
      return { ok: true, messageId: info.messageId, transport: label };
    } catch (error) {
      lastError = error;
      console.error(
        `[Email] Send failed via ${label}: ${error.message}` +
          (error.responseCode ? ` (code ${error.responseCode})` : '')
      );
    }
  }

  const classification = classifySmtpFailure(lastError, lastError?.responseCode);
  console.error(`[Email] Failure kind=${classification.kind}: ${classification.hint}`);

  return {
    ok: false,
    error: lastError?.message || 'All SMTP transports failed',
    responseCode: lastError?.responseCode,
    kind: classification.kind,
    hint: classification.hint,
  };
}

async function verifySmtpOnStartup() {
  if (!isEmailConfigured()) {
    return;
  }

  const user = getSmtpUser();
  const pass = getSmtpPass();
  const transports = getTransportOptionsList(user, pass);
  let verified = false;

  for (const options of transports) {
    const label = describeTransportOptions(options);
    try {
      await verifyTransport(options);
      console.log(`[Email] SMTP verified via ${label} for ${user}`);
      verified = true;
      break;
    } catch (error) {
      console.error(
        `[Email] SMTP verify failed via ${label}: ${error.message}` +
          (error.responseCode ? ` (code ${error.responseCode})` : '')
      );
    }
  }

  if (!verified) {
    const service = normalizeEnvValue(process.env.SMTP_SERVICE) || '(unset → gmail)';
    console.error(
      `[Email] SMTP could not be verified (SMTP_SERVICE=${service}, user=${user}). ` +
        'Check SMTP_SERVICE=gmail, regenerate a Gmail App Password for SMTP_PASS on Render, ' +
        'then visit https://accounts.google.com/DisplayUnlockCaptcha while logged into that Gmail account.'
    );
  }
}

async function sendViaBrevoHttp({ from, to, subject, text, html }) {
  const apiKey = normalizeEnvValue(process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY);
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { email: from, name: 'LeverageX' },
        to: [{ email: to }],
        subject,
        textContent: text || undefined,
        htmlContent: html || undefined,
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = body?.message || `Brevo HTTP ${response.status}`;
      console.error('[Email] Brevo send failed:', msg);
      return { ok: false, error: msg, kind: 'http_provider', transport: 'brevo-http' };
    }

    console.log(`[Email] Sent via brevo-http to ${to}`);
    return {
      ok: true,
      messageId: body?.messageId || body?.messageId || 'brevo',
      transport: 'brevo-http',
    };
  } catch (error) {
    console.error('[Email] Brevo send threw:', error.message);
    return { ok: false, error: error.message, kind: 'network', transport: 'brevo-http' };
  }
}

async function sendViaResendHttp({ from, to, subject, text, html }) {
  const apiKey = normalizeEnvValue(process.env.RESEND_API_KEY);
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text: text || undefined,
        html: html || undefined,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = body?.message || `Resend HTTP ${response.status}`;
      console.error('[Email] Resend send failed:', msg);
      return { ok: false, error: msg, kind: 'http_provider', transport: 'resend-http' };
    }
    console.log(`[Email] Sent via resend-http to ${to}`);
    return { ok: true, messageId: body?.id || 'resend', transport: 'resend-http' };
  } catch (error) {
    console.error('[Email] Resend send threw:', error.message);
    return { ok: false, error: error.message, kind: 'network', transport: 'resend-http' };
  }
}

/**
 * Send an email via SMTP (Gmail app password) with HTTPS provider fallback.
 * Render often cannot open smtp.gmail.com — BREVO_API_KEY / RESEND_API_KEY use HTTPS:443.
 */
async function sendEmail({ to, subject, text, html }) {
  if (!isEmailConfigured() && !normalizeEnvValue(process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY || process.env.RESEND_API_KEY)) {
    const msg = 'SMTP_USER / SMTP_PASS are required but not set';
    console.error('[Email]', msg);
    return {
      ok: false,
      skipped: true,
      error: msg,
      kind: 'not_configured',
      hint: 'Set SMTP_USER and SMTP_PASS (Gmail App Password) on Render, or BREVO_API_KEY / RESEND_API_KEY.',
    };
  }

  const from = buildFromAddress() || getSmtpUser() || normalizeEnvValue(process.env.EMAIL_FROM).toLowerCase();
  const toAddress = String(to || '').trim().toLowerCase();
  if (!from) {
    const msg = 'SMTP_USER / EMAIL_FROM is missing or invalid';
    console.error('[Email]', msg);
    return { ok: false, error: msg, kind: 'not_configured', hint: msg };
  }
  if (!toAddress) {
    const msg = 'Recipient email is missing';
    console.error('[Email]', msg);
    return { ok: false, error: msg, kind: 'invalid_recipient', hint: msg };
  }

  // Prefer HTTPS providers first when configured (works on Render when SMTP is blocked).
  const brevoFirst = await sendViaBrevoHttp({ from, to: toAddress, subject, text, html });
  if (brevoFirst?.ok) {
    return { ok: true, messageId: brevoFirst.messageId, transport: brevoFirst.transport };
  }
  const resendFirst = await sendViaResendHttp({ from, to: toAddress, subject, text, html });
  if (resendFirst?.ok) {
    return { ok: true, messageId: resendFirst.messageId, transport: resendFirst.transport };
  }

  if (isEmailConfigured()) {
    const result = await sendWithFallbackTransports({
      from,
      to: toAddress,
      subject,
      text,
      html,
    });

    if (result.ok) {
      return { ok: true, messageId: result.messageId, transport: result.transport };
    }

    console.error(
      `[Email] All transports failed for to=${toAddress} from=${from}: ${result.error}` +
        (result.responseCode ? ` (code ${result.responseCode})` : '') +
        (result.hint ? ` | ${result.hint}` : '')
    );

    return {
      ok: false,
      error: result.error,
      responseCode: result.responseCode,
      kind: result.kind,
      hint: result.hint,
    };
  }

  const providerError = brevoFirst || resendFirst;
  return {
    ok: false,
    error: providerError?.error || 'No email transport available',
    kind: providerError?.kind || 'not_configured',
    hint: 'Set BREVO_API_KEY (recommended on Render) or SMTP_USER/SMTP_PASS.',
  };
}

async function sendWelcomeEmail({ email, fullName }) {
  const name = String(fullName || 'Trader').trim();
  return sendEmail({
    to: email,
    subject: 'Welcome to LeverageX',
    text: ` Dear ${name},

Thank you for choosing Leveragex (leveragex.shop) for your Forex trading and investing needs!


We're excited to have you onboard and look forward to helping you navigate the markets. Our team is dedicated to providing top-notch services and support to ensure your success.


To get started, please find below some helpful resources:


- Our Website: leveragex (for market updates, tutorials, and more)
- Support Email: leveragexfund@gmail.com (for any questions or concerns)


Next Steps:


1. Verify your account (if you haven't already)
2. Explore our trading platforms and tools
3. Reach out to our support team for personalized guidance


We're committed to helping you achieve your financial goals. Stay updated on market trends and analysis through our regular newsletters and updates.


Best regards,
Suresh Sharma 
Leveragex Team
leveragexfund@gmail.com`,
  });
}

async function sendAdminOtpEmail({ email, fullName, otp }) {
  const name = String(fullName || 'Admin').trim();
  const code = String(otp || '').trim();
  return sendEmail({
    to: email,
    subject: 'LeverageX admin login code',
    text:
      `Hello ${name},\n\nYour admin login verification code is: ${code}\n\n` +
      `This code expires in 10 minutes. Do not share it with anyone.\n\n— LeverageX`,
  });
}

module.exports = {
  isEmailConfigured,
  verifySmtpOnStartup,
  sendEmail,
  sendWelcomeEmail,
  sendAdminOtpEmail,
  classifySmtpFailure,
};
