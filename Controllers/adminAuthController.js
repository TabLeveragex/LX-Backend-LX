const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Admin = require('../Models/adminModel');
const { getClientIp, logAdminLoginAttempt } = require('../Services/adminAuditService');
const { sendAdminOtpEmail } = require('../Services/emailService');
const { getAdminOtpRecipientEmail } = require('../Services/adminOtpRecipientService');
const {
  createAdminOtpChallenge,
  verifyAdminOtpChallenge,
} = require('../Services/adminOtpService');
const {
  registerAdminSession,
  clearAdminSessionById,
  getActiveSessionLockInfo,
} = require('../Services/adminSessionService');

const ACTIVE_SESSION_MSG =
  'Another admin is already using the dashboard. Only one admin can access it at a time for up to 24 hours.';

const adminLogin = async (req, res) => {
  const { loginId, password, traderSessionWasActive = false } = req.body;
  const normalizedLoginId = String(loginId || '').trim().toLowerCase();
  const hadTraderSession = Boolean(traderSessionWasActive);

  try {
    const admin = await Admin.findOne({
      $or: [{ email: normalizedLoginId }, { username: normalizedLoginId }],
    });

    const errorMsg = 'Invalid admin email/username or password';
    if (!admin) {
      await logAdminLoginAttempt(req, {
        loginId: normalizedLoginId,
        success: false,
        stage: 'credentials_failed',
        failureReason: 'invalid_credentials',
        traderSessionWasActive: hadTraderSession,
      });
      return res.status(403).json({ message: errorMsg, success: false });
    }

    const passwordMatches = await bcrypt.compare(password, admin.password);
    if (!passwordMatches) {
      await logAdminLoginAttempt(req, {
        loginId: normalizedLoginId,
        success: false,
        stage: 'credentials_failed',
        failureReason: 'invalid_credentials',
        traderSessionWasActive: hadTraderSession,
      });
      return res.status(403).json({ message: errorMsg, success: false });
    }

    const existingLock = await getActiveSessionLockInfo();
    if (existingLock) {
      await logAdminLoginAttempt(req, {
        loginId: normalizedLoginId,
        success: false,
        stage: 'session_blocked',
        failureReason: 'active_session',
        traderSessionWasActive: hadTraderSession,
      });
      return res.status(409).json({
        message: existingLock.message || ACTIVE_SESSION_MSG,
        success: false,
        sessionLocked: true,
        lockedUntil: existingLock.expiresAt,
        remainingLabel: existingLock.remainingLabel,
      });
    }

    const { challengeToken, otp } = await createAdminOtpChallenge(admin._id);
    const otpRecipient = getAdminOtpRecipientEmail(admin);
    if (!otpRecipient) {
      return res.status(503).json({
        message: 'Admin email is not configured. Set ADMIN_EMAIL to your real Gmail on Render.',
        success: false,
      });
    }

    console.log(`[AdminLogin] Sending OTP to ${otpRecipient} (admin record: ${admin.email})`);

    let mailResult;
    try {
      mailResult = await sendAdminOtpEmail({
        email: otpRecipient,
        fullName: admin.fullName,
        otp,
      });
    } catch (mailErr) {
      console.error('[AdminLogin] OTP email threw unexpectedly:', mailErr);
      mailResult = {
        ok: false,
        error: mailErr?.message || 'Unexpected email error',
        kind: 'exception',
        hint: 'SMTP send threw an exception. Check server logs.',
      };
    }

    if (!mailResult.ok) {
      // Render often blocks outbound Gmail SMTP. Keep admin login usable by
      // returning the OTP in the API response when mail cannot be delivered.
      const allowOtpFallback =
        String(process.env.ADMIN_OTP_FALLBACK_IN_RESPONSE || 'true').toLowerCase() !== 'false';

      if (allowOtpFallback) {
        console.warn(
          `[AdminLogin] Email failed (${mailResult.kind || 'unknown'}): ${mailResult.error || ''}. ` +
            `Returning OTP in API response for ${otpRecipient}. Set BREVO_API_KEY for HTTPS email delivery.`
        );
        console.warn(`[AdminLogin] OTP for ${otpRecipient}: ${otp}`);
        await logAdminLoginAttempt(req, {
          loginId: normalizedLoginId,
          success: false,
          stage: 'otp_sent_fallback',
          otpSentTo: otpRecipient,
          traderSessionWasActive: hadTraderSession,
        });
        return res.status(200).json({
          message:
            'Could not email the login code from the server. Your verification code is shown on screen — enter it below.',
          success: true,
          requiresOtp: true,
          challengeToken,
          otpSentTo: otpRecipient,
          debugOtp: otp,
          emailErrorKind: mailResult.kind || 'send_failed',
        });
      }

      await logAdminLoginAttempt(req, {
        loginId: normalizedLoginId,
        success: false,
        stage: 'otp_email_failed',
        failureReason: 'email_failed',
        traderSessionWasActive: hadTraderSession,
      });
      const message =
        mailResult.kind === 'network'
          ? 'Could not reach Gmail SMTP from Render. Add BREVO_API_KEY for HTTPS email, or set ADMIN_OTP_FALLBACK_IN_RESPONSE=true.'
          : 'Could not send admin login code. Check SMTP settings on Render.';
      console.error(
        '[AdminLogin] OTP email failed for',
        otpRecipient,
        '—',
        mailResult.error || 'unknown error',
        mailResult.kind ? `kind=${mailResult.kind}` : ''
      );
      return res.status(503).json({
        message,
        success: false,
        emailErrorKind: mailResult.kind || 'send_failed',
      });
    }

    console.log(
      '[AdminLogin] OTP email sent to',
      otpRecipient,
      mailResult.messageId ? `messageId=${mailResult.messageId}` : ''
    );

    await logAdminLoginAttempt(req, {
      loginId: normalizedLoginId,
      success: false,
      stage: 'otp_sent',
      otpSentTo: otpRecipient,
      traderSessionWasActive: hadTraderSession,
    });

    res.status(200).json({
      message: 'Verification code sent to your admin email.',
      success: true,
      requiresOtp: true,
      challengeToken,
      otpSentTo: otpRecipient,
    });
  } catch (err) {
    console.error('Admin login error:', err);
    await logAdminLoginAttempt(req, {
      loginId: normalizedLoginId,
      success: false,
      stage: 'server_error',
      failureReason: 'server_error',
      traderSessionWasActive: hadTraderSession,
    });
    res.status(500).json({ message: 'Internal server error', success: false });
  }
};

const adminVerifyOtp = async (req, res) => {
  const { challengeToken, otp, traderSessionWasActive = false } = req.body;
  const hadTraderSession = Boolean(traderSessionWasActive);

  try {
    const adminId = await verifyAdminOtpChallenge(challengeToken, otp);
    if (!adminId) {
      await logAdminLoginAttempt(req, {
        loginId: 'otp_verify',
        success: false,
        stage: 'otp_failed',
        failureReason: 'invalid_otp',
        traderSessionWasActive: hadTraderSession,
      });
      return res.status(403).json({
        message: 'Invalid or expired verification code.',
        success: false,
      });
    }

    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(403).json({ message: 'Admin account not found.', success: false });
    }

    const lockAtVerify = await getActiveSessionLockInfo();
    if (lockAtVerify) {
      await logAdminLoginAttempt(req, {
        loginId: admin.email,
        success: false,
        stage: 'session_blocked',
        failureReason: 'active_session',
        traderSessionWasActive: hadTraderSession,
      });
      return res.status(409).json({
        message: lockAtVerify.message || ACTIVE_SESSION_MSG,
        success: false,
        sessionLocked: true,
        lockedUntil: lockAtVerify.expiresAt,
        remainingLabel: lockAtVerify.remainingLabel,
      });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error('Admin OTP verify error: JWT_SECRET is not set');
      return res.status(503).json({
        message: 'Server configuration error. Please contact support.',
        success: false,
      });
    }

    const { sessionId, expiresAt } = await registerAdminSession(admin._id, {
      ip: getClientIp(req),
      userAgent: String(req.headers['user-agent'] || ''),
    });

    const jwtToken = jwt.sign(
      {
        email: admin.email,
        _id: admin._id,
        role: 'admin',
        adminSessionId: sessionId,
      },
      jwtSecret,
      { expiresIn: '24h' }
    );

    await logAdminLoginAttempt(req, {
      loginId: admin.email,
      success: true,
      stage: 'login_success',
      traderSessionWasActive: hadTraderSession,
    });

    res.status(200).json({
      message: 'Admin login successful. This dashboard seat is locked for 24 hours — no other admin can sign in until you log out or the lock expires.',
      success: true,
      jwtToken,
      adminId: admin._id,
      email: admin.email,
      username: admin.username,
      fullName: admin.fullName,
      sessionExpiresAt: expiresAt,
      exclusiveAccessHours: 24,
    });
  } catch (err) {
    console.error('Admin OTP verify error:', err);
    res.status(500).json({ message: 'Internal server error', success: false });
  }
};

const getAdminMe = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      adminId: req.admin.id,
      email: req.admin.email,
      username: req.admin.username,
      fullName: req.admin.fullName,
    });
  } catch (err) {
    res.status(500).json({ message: 'Internal server error', success: false });
  }
};

function extractAdminToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return header || null;
}

const adminLogout = async (req, res) => {
  try {
    const token = extractAdminToken(req);
    const jwtSecret = process.env.JWT_SECRET;
    if (token && jwtSecret) {
      try {
        const decoded = jwt.verify(token, jwtSecret);
        if (decoded?.adminSessionId) {
          await clearAdminSessionById(decoded.adminSessionId);
        }
      } catch {
        // Token may already be expired; still return success for client cleanup.
      }
    }
    res.status(200).json({ message: 'Logged out', success: true });
  } catch (err) {
    console.error('Admin logout error:', err);
    res.status(500).json({ message: 'Internal server error', success: false });
  }
};

module.exports = {
  adminLogin,
  adminVerifyOtp,
  adminLogout,
  getAdminMe,
};
