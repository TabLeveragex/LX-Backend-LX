function formatJoiError(error) {
  if (!error || !error.details?.length) {
    return 'Bad request';
  }
  return error.details.map((d) => d.message).join(', ');
}

function getMissingEnvVars() {
  const required = [
    'MONGO_CONN',
    'JWT_SECRET',
    'SMTP_USER',
    'SMTP_PASS',
  ];
  return required.filter((key) => !String(process.env[key] || '').trim());
}

function logRequiredEnvOnStartup() {
  const missing = getMissingEnvVars();
  if (missing.length) {
    console.error(
      `[Startup] Missing required environment variables: ${missing.join(', ')}`
    );
    process.exit(1);
  }

  const service = String(process.env.SMTP_SERVICE || '').trim();
  if (service) {
    let wellKnown = null;
    try {
      wellKnown = require('nodemailer/lib/well-known')(service.toLowerCase());
    } catch {
      wellKnown = null;
    }
    if (!wellKnown) {
      console.warn(
        `[Startup] SMTP_SERVICE="${service}" is not a nodemailer well-known service. ` +
          'Email sends will fall back to Gmail SMTP when SMTP_USER is a Gmail address. ' +
          'Prefer SMTP_SERVICE=gmail on Render.'
      );
    }
  }
}

module.exports = {
  formatJoiError,
  getMissingEnvVars,
  logRequiredEnvOnStartup,
};
