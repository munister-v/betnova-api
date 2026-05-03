const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')

// GET /api/transaction/history-page
router.get('/history-page', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const type = req.query.type // deposit | withdrawal | bet | win
    const offset = (page - 1) * limit

    let query = supabaseAdmin
      .from('transactions')
      .select('id, type, amount, status, created_at, metadata', { count: 'exact' })
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (type) query = query.eq('type', type)

    const { data, error, count } = await query

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, transactions: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/transaction/stats-page
router.get('/stats-page', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('transactions')
      .select('type, amount')
      .eq('user_id', req.user.sub)
      .eq('status', 'completed')

    const totalDeposited = data?.filter(t => t.type === 'deposit').reduce((s, t) => s + t.amount, 0) || 0
    const totalWithdrawn = data?.filter(t => t.type === 'withdrawal').reduce((s, t) => s + t.amount, 0) || 0

    return res.json({ success: true, totalDeposited, totalWithdrawn })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/transaction/ref/:ref
router.get('/ref/:ref', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.sub)
      .eq('reference', req.params.ref)
      .single()

    if (!data) return res.status(404).json({ success: false, error: 'Transaction not found' })

    return res.json({ success: true, transaction: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
