'use strict';

const crypto = require('crypto');

const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(password), salt, KEYLEN);
  const hashBuf = Buffer.from(hash, 'hex');
  if (check.length !== hashBuf.length) return false;
  return crypto.timingSafeEqual(check, hashBuf);
}

module.exports = { hashPassword, verifyPassword };
