const jwt = require('jsonwebtoken')
const config = require('../config')

function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

function setCookieToken(res, token) {
  const isProd = process.env.NODE_ENV === 'production'
  res.cookie('platform_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

function clearCookieToken(res) {
  const isProd = process.env.NODE_ENV === 'production'
  res.clearCookie('platform_token', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  })
}

module.exports = { signToken, setCookieToken, clearCookieToken }
