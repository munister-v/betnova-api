const jwt = require('jsonwebtoken')
const { supabaseAdmin } = require('../config/supabase')
const config = require('../config')

const onlineUsers = new Map() // socketId → userId

function setupSocket(io, app) {
  // Auth middleware for socket
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie
      ?.split(';')
      .find(c => c.trim().startsWith('platform_token='))
      ?.split('=')[1]

    if (token) {
      try {
        socket.user = jwt.verify(token, config.jwtSecret)
      } catch (_) {}
    }

    next()
  })

  io.on('connection', (socket) => {
    const userId = socket.user?.sub
    if (userId) {
      onlineUsers.set(socket.id, userId)
      app.set('onlineCount', onlineUsers.size)
      io.emit('chat:online', { count: onlineUsers.size })
    }

    // Join a game room for real-time updates
    socket.on('join:game', ({ gameType }) => {
      socket.join(`game:${gameType}`)
      const activePlayers = app.get('activePlayers') || {}
      activePlayers[gameType] = (activePlayers[gameType] || 0) + 1
      app.set('activePlayers', activePlayers)
      io.to(`game:${gameType}`).emit('game:players', { gameType, count: activePlayers[gameType] })
    })

    socket.on('leave:game', ({ gameType }) => {
      socket.leave(`game:${gameType}`)
      const activePlayers = app.get('activePlayers') || {}
      activePlayers[gameType] = Math.max(0, (activePlayers[gameType] || 1) - 1)
      app.set('activePlayers', activePlayers)
      io.to(`game:${gameType}`).emit('game:players', { gameType, count: activePlayers[gameType] })
    })

    // Chat message
    socket.on('chat:send', async (data) => {
      if (!socket.user) {
        socket.emit('chat:error', { error: 'Authentication required' })
        return
      }

      const content = data?.content?.trim()
      if (!content || content.length > 500) {
        socket.emit('chat:error', { error: 'Invalid message' })
        return
      }

      try {
        const { data: msg, error } = await supabaseAdmin
          .from('chat_messages')
          .insert({ user_id: socket.user.sub, content })
          .select('id, content, created_at, users(id, username, avatar_url)')
          .single()

        if (error) throw error

        io.emit('chat:message', msg)
      } catch (err) {
        socket.emit('chat:error', { error: 'Failed to send message' })
      }
    })

    socket.on('disconnect', () => {
      if (onlineUsers.has(socket.id)) {
        onlineUsers.delete(socket.id)
        app.set('onlineCount', onlineUsers.size)
        io.emit('chat:online', { count: onlineUsers.size })
      }
    })
  })
}

module.exports = { setupSocket }
