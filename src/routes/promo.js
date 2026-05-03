const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')

// POST /api/promo/redeem
// Body: { code }
router.post('/redeem', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body
    const userId = req.user.sub

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'Code required' })
    }

    const normalized = code.trim().toUpperCase()

    // Find promo
    const { data: promo, error: promoErr } = await supabaseAdmin
      .from('promo_codes')
      .select('*')
      .eq('code', normalized)
      .single()

    if (promoErr || !promo) {
      return res.status(404).json({ success: false, error: 'Invalid code' })
    }

    if (!promo.active) {
      return res.status(400).json({ success: false, error: 'Code is no longer active' })
    }

    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'Code has expired' })
    }

    if (promo.max_uses && promo.used_count >= promo.max_uses) {
      return res.status(400).json({ success: false, error: 'Code has reached its usage limit' })
    }

    // Check if user already redeemed
    const { data: existing } = await supabaseAdmin
      .from('promo_redemptions')
      .select('id')
      .eq('user_id', userId)
      .eq('promo_code_id', promo.id)
      .maybeSingle()

    if (existing) {
      return res.status(400).json({ success: false, error: 'You already redeemed this code' })
    }

    // Credit user balance
    const { data: user } = await supabaseAdmin
      .from('users').select('balance').eq('id', userId).single()

    const newBalance = (user?.balance || 0) + promo.amount

    await supabaseAdmin.from('users').update({ balance: newBalance }).eq('id', userId)

    // Record redemption
    await supabaseAdmin.from('promo_redemptions').insert({
      user_id: userId,
      promo_code_id: promo.id,
      amount: promo.amount,
    })

    // Increment used_count
    await supabaseAdmin
      .from('promo_codes')
      .update({ used_count: (promo.used_count || 0) + 1 })
      .eq('id', promo.id)

    // Log as transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      type: 'bonus',
      amount: promo.amount,
      status: 'completed',
      reference: `promo_${promo.code}`,
      metadata: { code: promo.code },
    })

    res.json({
      success: true,
      amount: promo.amount,
      newBalance,
      message: `+$${promo.amount.toFixed(2)} added to your balance!`,
    })
  } catch (err) {
    console.error('Promo redeem error:', err)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/promo/my-redemptions — list user's redemption history
router.get('/my-redemptions', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('promo_redemptions')
      .select('id, amount, redeemed_at, promo_codes(code)')
      .eq('user_id', req.user.sub)
      .order('redeemed_at', { ascending: false })
      .limit(50)

    if (error) return res.status(500).json({ success: false, error: error.message })

    res.json({ success: true, redemptions: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
