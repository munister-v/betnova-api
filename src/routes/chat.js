const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware, optionalAuth } = require('../middleware/auth')

// GET /api/chat/messages
router.get('/messages', optionalAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50
    const before = req.query.before // message id for pagination

    let query = supabaseAdmin
      .from('chat_messages')
      .select('id, content, created_at, users(id, username, avatar_url)')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (before) {
      query = query.lt('id', before)
    }

    const { data, error } = await query

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, messages: data.reverse() })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// DELETE /api/chat/:messageId
router.delete('/:messageId', authMiddleware, async (req, res) => {
  try {
    const { data: msg } = await supabaseAdmin
      .from('chat_messages')
      .select('user_id')
      .eq('id', req.params.messageId)
      .single()

    if (!msg) return res.status(404).json({ success: false, error: 'Message not found' })
    if (msg.user_id !== req.user.sub) return res.status(403).json({ success: false, error: 'Forbidden' })

    await supabaseAdmin.from('chat_messages').delete().eq('id', req.params.messageId)

    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/chat/stats
router.get('/stats', async (req, res) => {
  try {
    const { count } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })

    return res.json({ success: true, totalMessages: count || 0 })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/chat/online — returns count from socket store (injected by server)
router.get('/online', (req, res) => {
  const onlineCount = req.app.get('onlineCount') || 0
  return res.json({ success: true, online: onlineCount })
})

// GET /api/chat/history
router.get('/history', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50
  const page = parseInt(req.query.page) || 1
  const offset = (page - 1) * limit

  const { data, error, count } = await supabaseAdmin
    .from('chat_messages')
    .select('id, content, created_at, users(username, avatar_url)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) return res.status(500).json({ success: false, error: error.message })

  return res.json({ success: true, messages: data, total: count, page, limit })
})

// GET /api/chat/search
router.get('/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ success: false, error: 'Query required' })

  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('id, content, created_at, users(username, avatar_url)')
    .ilike('content', `%${q}%`)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return res.status(500).json({ success: false, error: error.message })

  return res.json({ success: true, messages: data })
})

module.exports = router
