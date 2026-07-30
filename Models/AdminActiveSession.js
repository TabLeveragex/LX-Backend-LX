const mongoose = require('mongoose');

const adminActiveSessionSchema = new mongoose.Schema({
  singletonKey: { type: String, default: 'global', unique: true },
  sessionId: { type: String, required: true, index: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  expiresAt: { type: Date, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
});

// Auto-remove expired lock documents.
adminActiveSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.AdminActiveSession ||
  mongoose.model('AdminActiveSession', adminActiveSessionSchema);
