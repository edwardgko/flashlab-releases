import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from './supabaseClient.js'

// Paleta de 10 colores vibrantes y elegantes estilo Google Docs / Word / Figma
export const COLLABORATOR_COLORS = [
  { bg: '#2563eb', text: '#ffffff', border: '#60a5fa', light: '#eff6ff', ring: 'rgba(37, 99, 235, 0.35)', name: 'Azul' },
  { bg: '#059669', text: '#ffffff', border: '#34d399', light: '#ecfdf5', ring: 'rgba(5, 150, 105, 0.35)', name: 'Verde' },
  { bg: '#d97706', text: '#ffffff', border: '#fbbf24', light: '#fffbeb', ring: 'rgba(217, 119, 6, 0.35)', name: 'Ámbar' },
  { bg: '#7c3aed', text: '#ffffff', border: '#a78bfa', light: '#f5f3ff', ring: 'rgba(124, 58, 237, 0.35)', name: 'Violeta' },
  { bg: '#db2777', text: '#ffffff', border: '#f472b6', light: '#fdf2f8', ring: 'rgba(219, 39, 119, 0.35)', name: 'Rosa' },
  { bg: '#0891b2', text: '#ffffff', border: '#22d3ee', light: '#ecfeff', ring: 'rgba(8, 145, 178, 0.35)', name: 'Cian' },
  { bg: '#ea580c', text: '#ffffff', border: '#fb923c', light: '#fff7ed', ring: 'rgba(234, 88, 12, 0.35)', name: 'Naranja' },
  { bg: '#4f46e5', text: '#ffffff', border: '#818cf8', light: '#eef2ff', ring: 'rgba(79, 70, 229, 0.35)', name: 'Índigo' },
  { bg: '#0d9488', text: '#ffffff', border: '#2dd4bf', light: '#f0fdfa', ring: 'rgba(13, 148, 136, 0.35)', name: 'Turquesa' },
  { bg: '#e11d48', text: '#ffffff', border: '#fb7185', light: '#fff1f2', ring: 'rgba(225, 29, 72, 0.35)', name: 'Rojo' },
]

export function getUserColor(idOrEmail) {
  if (!idOrEmail) return COLLABORATOR_COLORS[0]
  let hash = 0
  const str = String(idOrEmail)
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  const index = Math.abs(hash) % COLLABORATOR_COLORS.length
  return COLLABORATOR_COLORS[index]
}

const THROTTLE_MS = 50
const CURSOR_TIMEOUT_MS = 6000

export function usePagePresence(pageId, session, scrollContainerRef) {
  const [collaborators, setCollaborators] = useState([])
  const [remoteCursors, setRemoteCursors] = useState({})
  const channelRef = useRef(null)
  const lastSendTimeRef = useRef(0)
  const lastPosRef = useRef({ x: 0, y: 0 })

  const currentUser = session?.user
  const myId = currentUser?.id || 'anon-' + Math.random().toString(36).slice(2, 9)
  const myName =
    currentUser?.user_metadata?.full_name ||
    currentUser?.user_metadata?.name ||
    currentUser?.email?.split('@')[0] ||
    'Usuario'
  const myAvatar = currentUser?.user_metadata?.avatar_url || currentUser?.user_metadata?.picture || null
  const myColor = getUserColor(myId || currentUser?.email)

  // 1. Manejo del canal de Presencia y Broadcast en tiempo real
  useEffect(() => {
    if (!pageId) return

    const channelName = `presence-page-${pageId}`
    const channel = supabase.channel(channelName, {
      config: {
        presence: { key: myId },
      },
    })
    channelRef.current = channel

    // Sincronización de presencia (quiénes están en la página)
    const updatePresenceState = () => {
      const state = channel.presenceState()
      const others = []
      for (const [key, presences] of Object.entries(state)) {
        if (key === myId) continue
        if (Array.isArray(presences) && presences.length > 0) {
          const latest = presences[presences.length - 1]
          others.push({
            userId: key,
            name: latest.name || 'Compañero',
            email: latest.email || '',
            avatarUrl: latest.avatarUrl || null,
            color: latest.color || getUserColor(key),
            lastActive: latest.timestamp || Date.now(),
          })
        }
      }
      setCollaborators(others)
    }

    channel
      .on('presence', { event: 'sync' }, updatePresenceState)
      .on('presence', { event: 'join' }, updatePresenceState)
      .on('presence', { event: 'leave' }, updatePresenceState)
      .on('broadcast', { event: 'cursor-move' }, ({ payload }) => {
        if (!payload || payload.userId === myId) return
        setRemoteCursors((prev) => ({
          ...prev,
          [payload.userId]: {
            ...payload,
            lastSeen: Date.now(),
          },
        }))
      })
      .on('broadcast', { event: 'cursor-hide' }, ({ payload }) => {
        if (!payload || payload.userId === myId) return
        setRemoteCursors((prev) => {
          const next = { ...prev }
          if (next[payload.userId]) {
            next[payload.userId] = { ...next[payload.userId], hidden: true }
          }
          return next
        })
      })
      .on('broadcast', { event: 'element-focus' }, ({ payload }) => {
        if (!payload || payload.userId === myId) return
        setRemoteCursors((prev) => {
          const existing = prev[payload.userId] || {
            userId: payload.userId,
            name: payload.name,
            color: payload.color,
          }
          return {
            ...prev,
            [payload.userId]: {
              ...existing,
              activeBlockId: payload.blockId ?? null,
              activeBlockIndex: payload.blockIndex ?? null,
              activeRowId: payload.rowId ?? null,
              activePropId: payload.propId ?? null,
              lastSeen: Date.now(),
            },
          }
        })
      })
      .on('broadcast', { event: 'caret-move' }, ({ payload }) => {
        if (!payload || payload.userId === myId) return
        setRemoteCursors((prev) => {
          const existing = prev[payload.userId] || {
            userId: payload.userId,
            name: payload.name,
            color: payload.color,
          }
          return {
            ...prev,
            [payload.userId]: {
              ...existing,
              name: payload.name || existing.name,
              color: payload.color || existing.color,
              caret: payload.clear ? null : payload.caret,
              activeBlockId: payload.clear ? null : (payload.blockId ?? existing.activeBlockId),
              activeBlockIndex: payload.clear ? null : (payload.blockIndex ?? existing.activeBlockIndex),
              liveHtml: payload.html ?? existing.liveHtml,
              liveText: payload.text ?? existing.liveText,
              lastSeen: Date.now(),
            },
          }
        })
      })

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        try {
          await channel.track({
            userId: myId,
            name: myName,
            email: currentUser?.email || '',
            avatarUrl: myAvatar,
            color: myColor,
            timestamp: Date.now(),
          })
        } catch (err) {
          console.warn('[presence] error al registrar presencia:', err)
        }
      }
    })

    // Limpieza periódica de cursores inactivos
    const cleanupInterval = setInterval(() => {
      const now = Date.now()
      setRemoteCursors((prev) => {
        let changed = false
        const next = {}
        for (const [id, c] of Object.entries(prev)) {
          if (now - (c.lastSeen || 0) < CURSOR_TIMEOUT_MS) {
            next[id] = c
          } else {
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 2000)

    return () => {
      clearInterval(cleanupInterval)
      channel.unsubscribe()
      supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [pageId, myId, myName, myAvatar, myColor, currentUser?.email])

  // 2. Transmisión del puntero / mouse de alta frecuencia (throttled)
  const handleMouseMove = useCallback(
    (event) => {
      const channel = channelRef.current
      if (!channel) return

      const now = performance.now()
      if (now - lastSendTimeRef.current < THROTTLE_MS) return

      const container = scrollContainerRef?.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const x = Math.round(event.clientX - rect.left + container.scrollLeft)
      const y = Math.round(event.clientY - rect.top + container.scrollTop)

      // Si apenas cambió de lugar (< 2px), no desperdiciar mensaje
      if (Math.abs(x - lastPosRef.current.x) < 2 && Math.abs(y - lastPosRef.current.y) < 2) return

      lastPosRef.current = { x, y }
      lastSendTimeRef.current = now

      channel.send({
        type: 'broadcast',
        event: 'cursor-move',
        payload: {
          userId: myId,
          name: myName,
          color: myColor,
          x,
          y,
          hidden: false,
        },
      })
    },
    [myId, myName, myColor, scrollContainerRef]
  )

  const handleMouseLeave = useCallback(() => {
    const channel = channelRef.current
    if (!channel) return
    channel.send({
      type: 'broadcast',
      event: 'cursor-hide',
      payload: { userId: myId },
    })
  }, [myId])

  // 3. Notificar qué bloque o fila/celda se está editando
  const broadcastElementFocus = useCallback(
    ({ blockId = null, blockIndex = null, rowId = null, propId = null }) => {
      const channel = channelRef.current
      if (!channel) return
      channel.send({
        type: 'broadcast',
        event: 'element-focus',
        payload: {
          userId: myId,
          name: myName,
          color: myColor,
          blockId,
          blockIndex,
          rowId,
          propId,
        },
      })
    },
    [myId, myName, myColor]
  )

  // 4. Notificar la posición exacta del cursor de texto (caret) y contenido en vivo del bloque
  const lastCaretSendTimeRef = useRef(0)
  const broadcastCaretMove = useCallback(
    ({ caret = null, blockId = null, blockIndex = null, html = null, text = null, clear = false }) => {
      const channel = channelRef.current
      if (!channel) return

      const now = performance.now()
      if (!clear && now - lastCaretSendTimeRef.current < 35) return
      lastCaretSendTimeRef.current = now

      channel.send({
        type: 'broadcast',
        event: 'caret-move',
        payload: {
          userId: myId,
          name: myName,
          color: myColor,
          caret,
          blockId,
          blockIndex,
          html,
          text,
          clear,
        },
      })
    },
    [myId, myName, myColor]
  )

  return {
    collaborators,
    remoteCursors,
    myColor,
    handleMouseMove,
    handleMouseLeave,
    broadcastElementFocus,
    broadcastCaretMove,
  }
}
