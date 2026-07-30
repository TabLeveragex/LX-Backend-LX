const crypto = require('crypto');
const AdminActiveSession = require('../Models/AdminActiveSession');

/** Exclusive admin seat duration — one active dashboard login at a time. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function formatRemaining(expiresAt) {
  const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return `${Math.max(1, minutes)} minute(s)`;
  }
  if (minutes === 0) {
    return `${hours} hour(s)`;
  }
  return `${hours} hour(s) ${minutes} minute(s)`;
}

function buildActiveSessionMessage(active) {
  if (!active?.expiresAt) {
    return 'Another admin is already using the dashboard. Only one admin can access it at a time (lock lasts up to 24 hours).';
  }
  const remaining = formatRemaining(active.expiresAt);
  const until = new Date(active.expiresAt).toISOString();
  return (
    `Admin dashboard is locked by an active session. Only one admin can use it at a time. ` +
    `Try again in about ${remaining} (lock expires ${until}). ` +
    `If this is your session on another device, log out there first or wait for the 24-hour lock to expire.`
  );
}

async function getActiveAdminSession() {
  const doc = await AdminActiveSession.findOne({ singletonKey: 'global' });
  if (!doc) {
    return null;
  }
  if (doc.expiresAt < new Date()) {
    await AdminActiveSession.deleteOne({ _id: doc._id });
    return null;
  }
  return doc;
}

async function hasActiveAdminSession() {
  return Boolean(await getActiveAdminSession());
}

/**
 * Register the exclusive global admin seat for 24 hours.
 * Replaces any expired record; callers must check hasActiveAdminSession first.
 */
async function registerAdminSession(adminId, meta = {}) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await AdminActiveSession.findOneAndUpdate(
    { singletonKey: 'global' },
    {
      sessionId,
      adminId,
      expiresAt,
      createdAt: now,
      ip: meta.ip || '',
      userAgent: meta.userAgent || '',
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(
    `[AdminSession] Exclusive seat registered for admin=${adminId} until ${expiresAt.toISOString()}`
  );

  return { sessionId, expiresAt, ttlHours: 24 };
}

async function isAdminSessionValid(adminId, sessionId) {
  const active = await getActiveAdminSession();
  if (!active) {
    return false;
  }
  return (
    String(active.adminId) === String(adminId) &&
    String(active.sessionId) === String(sessionId || '')
  );
}

async function clearAdminSessionById(sessionId) {
  const active = await getActiveAdminSession();
  if (!active || active.sessionId !== String(sessionId || '')) {
    return false;
  }
  await AdminActiveSession.deleteOne({ _id: active._id });
  console.log(`[AdminSession] Exclusive seat cleared for session=${sessionId}`);
  return true;
}

async function getActiveSessionLockInfo() {
  const active = await getActiveAdminSession();
  if (!active) {
    return null;
  }
  return {
    locked: true,
    expiresAt: active.expiresAt,
    remainingMs: Math.max(0, active.expiresAt.getTime() - Date.now()),
    remainingLabel: formatRemaining(active.expiresAt),
    message: buildActiveSessionMessage(active),
  };
}

module.exports = {
  SESSION_TTL_MS,
  getActiveAdminSession,
  hasActiveAdminSession,
  registerAdminSession,
  isAdminSessionValid,
  clearAdminSessionById,
  getActiveSessionLockInfo,
  buildActiveSessionMessage,
};
