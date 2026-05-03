const jwt = require('jsonwebtoken')
const config = require('../config')

function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

function setCookieToken(res, token) {
  res.cookie('platform_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    domain: config.cookieDomain,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  })
}

function clearCookieToken(res) {
  res.clearCookie('platform_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    domain: config.cookieDomain,
  })
}

module.exports = { signToken, setCookieToken, clearCookieToken }
