const express = require('express')
const router = express.Router()
const { ethers } = require('ethers')
const { v4: uuidv4 } = require('uuid')
const { supabaseAdmin } = require('../config/supabase')
const { signToken, setCookieToken, clearCookieToken } = require('../utils/jwt')
const { authMiddleware } = require('../middleware/auth')

// In-memory nonce store (use Redis in production)
const nonceStore = new Map()

// POST /api/auth/exchange
// Exchanges a Supabase access token for a platform JWT cookie
router.post('/exchange', async (req, res) => {
  try {
    const { token } = req.body

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token required' })
    }

    // Verify token with Supabase
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid Supabase token' })
    }

    // Upsert user in our users table
    const { data: profile, error: upsertError } = await supabaseAdmin
      .from('users')
      .upsert({
        id: user.id,
        email: user.email,
        username: user.user_metadata?.name || user.email.split('@')[0],
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' })
      .select()
      .single()

    if (upsertError) {
      console.error('Upsert error:', upsertError)
      return res.status(500).json({ success: false, error: 'Failed to sync user' })
    }

    const platformToken = signToken({
      sub: user.id,
      email: user.email,
      username: profile.username,
    })

    setCookieToken(res, platformToken)

    return res.json({ success: true })
  } catch (err) {
    console.error('Exchange error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/auth/check
// Returns current auth status
router.get('/check', authMiddleware, async (req, res) => {
  return res.json({ success: true, authenticated: true, userId: req.user.sub })
})

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearCookieToken(res)
  return res.json({ success: true })
})

// POST /api/auth/wallet/nonce
// Returns a nonce message for MetaMask signing
router.post('/wallet/nonce', (req, res) => {
  const { walletAddress } = req.body

  if (!walletAddress) {
    return res.status(400).json({ success: false, error: 'walletAddress required' })
  }

  const nonce = uuidv4()
  const message = `Sign this message to authenticate with Crypto Casino.\n\nNonce: ${nonce}\nWallet: ${walletAddress}`

  // Store nonce for 5 minutes
  nonceStore.set(walletAddress.toLowerCase(), { nonce, message, expiresAt: Date.now() + 5 * 60 * 1000 })

  return res.json({ success: true, nonce, message })
})

// POST /api/auth/wallet/verify
// Verifies MetaMask signature and issues platform token
router.post('/wallet/verify', async (req, res) => {
  try {
    const { walletAddress, signature } = req.body

    if (!walletAddress || !signature) {
      return res.status(400).json({ success: false, error: 'walletAddress and signature required' })
    }

    const stored = nonceStore.get(walletAddress.toLowerCase())

    if (!stored || Date.now() > stored.expiresAt) {
      return res.status(400).json({ success: false, error: 'Nonce expired or not found' })
    }

    // Recover signer address from signature
    const recovered = ethers.verifyMessage(stored.message, signature)

    if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(401).json({ success: false, error: 'Signature verification failed' })
    }

    nonceStore.delete(walletAddress.toLowerCase())

    // Upsert wallet user
    const { data: profile, error } = await supabaseAdmin
      .from('users')
      .upsert({
        wallet_address: walletAddress.toLowerCase(),
        username: `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'wallet_address' })
      .select()
      .single()

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to sync wallet user' })
    }

    const platformToken = signToken({
      sub: profile.id,
      email: profile.email || '',
      username: profile.username,
      walletAddress: walletAddress.toLowerCase(),
    })

    setCookieToken(res, platformToken)

    return res.json({ success: true, user: profile })
  } catch (err) {
    console.error('Wallet verify error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
