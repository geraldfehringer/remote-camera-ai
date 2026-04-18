import { useCallback, useEffect, useRef, useState } from 'react'
import { getSignalUrl } from '../lib/api'
import type { AlertEventDTO } from '../lib/alerts'

export type SignalingRole = 'camera' | 'viewer'

export type RemoteControlPayload = { target?: string; zoom?: number }
export type RemoteCapabilitiesPayload = {
  zoomMin?: number
  zoomMax?: number
  zoomStep?: number
  torch?: boolean
}

type SignalEnvelope =
  | { type: 'session-state'; payload: Record<string, unknown> }
  | { type: 'peer-ready'; payload: Record<string, never> }
  | { type: 'description'; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'candidate'; payload: { candidate: RTCIceCandidateInit } }
  | { type: 'detection'; payload: unknown }
  | { type: 'alert'; payload: AlertEventDTO }
  | { type: 'control'; payload: RemoteControlPayload }
  | { type: 'capabilities'; payload: RemoteCapabilitiesPayload }
  | { type: 'error'; payload: { message: string } }

export type OutboundSignal =
  | { type: 'control'; payload: RemoteControlPayload }
  | { type: 'capabilities'; payload: RemoteCapabilitiesPayload }

export type SignalingStatus =
  | 'idle'
  | 'connecting'
  | 'waiting-peer'
  | 'negotiating'
  | 'connected'
  | 'disconnected'
  | 'fatal'

export type SignalingEnvelopeExtras =
  | { type: 'session-state'; payload: Record<string, unknown> }
  | { type: 'detection'; payload: unknown }
  | { type: 'alert'; payload: AlertEventDTO }
  | { type: 'control'; payload: RemoteControlPayload }
  | { type: 'capabilities'; payload: RemoteCapabilitiesPayload }
  | { type: 'error'; payload: { message: string } }

export type UseSignalingParams = {
  sessionId: string | null
  role: SignalingRole
  token: string | null
  iceServers: RTCIceServer[] | null
  localStream: MediaStream | null
  polite: boolean
  onEnvelope?: (envelope: SignalingEnvelopeExtras) => void
}

export type UseSignalingResult = {
  remoteStream: MediaStream | null
  status: SignalingStatus
  lastError: string | null
  sendSignal: (msg: OutboundSignal) => void
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8_000
const TERMINAL_CLOSE_CODES = new Set([1008, 1013, 4401, 4403, 4409])

function backoffDelay(attempt: number): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
  const jitter = exp * (0.9 + Math.random() * 0.2)
  return Math.round(jitter)
}

export function useSignaling(params: UseSignalingParams): UseSignalingResult {
  const { sessionId, role, token, iceServers, localStream, polite, onEnvelope } = params

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [status, setStatus] = useState<SignalingStatus>('idle')
  const [lastError, setLastError] = useState<string | null>(null)

  const envelopeRef = useRef(onEnvelope)
  envelopeRef.current = onEnvelope

  const streamRef = useRef(localStream)
  streamRef.current = localStream

  const iceServersRef = useRef(iceServers)
  iceServersRef.current = iceServers

  const peerContainerRef = useRef<{ pc: RTCPeerConnection | null }>({ pc: null })
  const wsRef = useRef<WebSocket | null>(null)

  const sendSignal = useCallback((msg: OutboundSignal) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  useEffect(() => {
    if (!sessionId || !token || !iceServers) {
      setStatus('idle')
      return
    }

    let cancelled = false
    let ws: WebSocket | null = null
    let pc: RTCPeerConnection | null = null
    let reconnectTimer: number | null = null
    let attempt = 0
    let makingOffer = false
    let ignoreOffer = false
    const pendingCandidates: RTCIceCandidateInit[] = []
    const setPc = (next: RTCPeerConnection | null) => {
      pc = next
      peerContainerRef.current.pc = next
    }

    const sendWs = (message: unknown) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message))
      }
    }

    const teardownPeer = () => {
      if (pc) {
        try { pc.ontrack = null } catch { /* ignore */ }
        try { pc.onicecandidate = null } catch { /* ignore */ }
        try { pc.onnegotiationneeded = null } catch { /* ignore */ }
        try { pc.oniceconnectionstatechange = null } catch { /* ignore */ }
        try { pc.onconnectionstatechange = null } catch { /* ignore */ }
        try { pc.close() } catch { /* ignore */ }
      }
      setPc(null)
      pendingCandidates.length = 0
      makingOffer = false
      ignoreOffer = false
      if (!cancelled) {
        setRemoteStream(null)
      }
    }

    const ensurePeer = (): RTCPeerConnection => {
      if (pc) return pc
      const next = new RTCPeerConnection({ iceServers: iceServersRef.current ?? undefined })

      next.onicecandidate = ({ candidate }) => {
        if (!candidate) return
        sendWs({ type: 'candidate', payload: { candidate: candidate.toJSON() } })
      }

      next.ontrack = (event) => {
        const [stream] = event.streams
        if (stream) setRemoteStream(stream)
      }

      next.onconnectionstatechange = () => {
        if (!pc) return
        if (pc.connectionState === 'connected') setStatus('connected')
        else if (pc.connectionState === 'failed') setStatus('disconnected')
      }

      next.onnegotiationneeded = async () => {
        if (!pc) return
        try {
          makingOffer = true
          setStatus('negotiating')
          await pc.setLocalDescription()
          sendWs({ type: 'description', payload: { sdp: pc.localDescription as RTCSessionDescriptionInit } })
        } catch (err) {
          console.error('[signaling] negotiationneeded failed', err)
          setLastError(err instanceof Error ? err.message : 'negotiation failed')
        } finally {
          makingOffer = false
        }
      }

      if (role === 'camera' && streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          next.addTrack(track, streamRef.current)
        }
      }

      setPc(next)
      return next
    }

    const handleSignal = async (msg: SignalEnvelope) => {
      if (
        msg.type === 'session-state' ||
        msg.type === 'detection' ||
        msg.type === 'error' ||
        msg.type === 'alert' ||
        msg.type === 'control' ||
        msg.type === 'capabilities'
      ) {
        envelopeRef.current?.(msg)
        if (msg.type === 'error') setLastError(msg.payload.message)
        return
      }

      if (msg.type === 'peer-ready') {
        if (role === 'camera' && pc) {
          if (pc.signalingState === 'have-local-offer' && pc.localDescription) {
            sendWs({ type: 'description', payload: { sdp: pc.localDescription } })
          } else if (pc.signalingState === 'stable') {
            teardownPeer()
            ensurePeer()
          }
        }
        return
      }

      const peer = ensurePeer()

      if (msg.type === 'description') {
        const desc = msg.payload.sdp
        const offerCollision =
          desc.type === 'offer' &&
          (makingOffer || peer.signalingState !== 'stable')
        ignoreOffer = !polite && offerCollision
        if (ignoreOffer) return

        try {
          await peer.setRemoteDescription(desc)
          while (pendingCandidates.length > 0) {
            const c = pendingCandidates.shift()
            if (!c) break
            await peer.addIceCandidate(c).catch((err) => {
              console.warn('[signaling] flush candidate failed', err)
            })
          }
          if (desc.type === 'offer') {
            await peer.setLocalDescription()
            sendWs({ type: 'description', payload: { sdp: peer.localDescription as RTCSessionDescriptionInit } })
          }
        } catch (err) {
          console.error('[signaling] description failed', err)
          setLastError(err instanceof Error ? err.message : 'description failed')
        }
        return
      }

      if (msg.type === 'candidate') {
        if (!peer.remoteDescription) {
          pendingCandidates.push(msg.payload.candidate)
          return
        }
        try {
          await peer.addIceCandidate(msg.payload.candidate)
        } catch (err) {
          if (!ignoreOffer) console.warn('[signaling] addIceCandidate failed', err)
        }
      }
    }

    const scheduleReconnect = (reason: string) => {
      if (cancelled) return
      setLastError(reason)
      setStatus('disconnected')
      const delay = backoffDelay(attempt)
      attempt += 1
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        if (!cancelled) connect()
      }, delay)
    }

    const connect = () => {
      if (cancelled) return
      setStatus('connecting')
      let signalQueue: Promise<void> = Promise.resolve()
      const socket = new WebSocket(getSignalUrl(sessionId, role, token))
      ws = socket
      wsRef.current = socket

      socket.onopen = () => {
        attempt = 0
        setLastError(null)
        setStatus('waiting-peer')
        ensurePeer()
      }

      socket.onmessage = (event) => {
        signalQueue = signalQueue
          .then(async () => {
            if (typeof event.data !== 'string') return
            let parsed: SignalEnvelope
            try {
              parsed = JSON.parse(event.data) as SignalEnvelope
            } catch (err) {
              console.warn('[signaling] malformed frame', err)
              return
            }
            await handleSignal(parsed)
          })
          .catch((err) => {
            console.error('[signaling] handler failed', err)
          })
      }

      socket.onerror = () => {
        // actual close handling happens in onclose
      }

      socket.onclose = (ev) => {
        ws = null
        if (wsRef.current === socket) wsRef.current = null
        teardownPeer()
        if (cancelled) return
        if (TERMINAL_CLOSE_CODES.has(ev.code)) {
          const msg =
            ev.code === 4409
              ? 'Eine neuere Verbindung fuer diese Rolle hat uebernommen.'
              : ev.code === 1013
                ? role === 'camera'
                  ? 'Eine Kamera ist in dieser Session bereits verbunden.'
                  : 'Ein Viewer ist in dieser Session bereits verbunden.'
                : `Signaling beendet (Code ${ev.code})`
          setLastError(msg)
          setStatus('fatal')
          return
        }
        scheduleReconnect(`Signaling unterbrochen (Code ${ev.code || 'unbekannt'})`)
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        try { ws.onclose = null } catch { /* ignore */ }
        try { ws.close(1000, 'unmount') } catch { /* ignore */ }
        wsRef.current = null
        ws = null
      }
      teardownPeer()
      setRemoteStream(null)
      setStatus('idle')
    }
  }, [sessionId, role, token, iceServers, polite])

  useEffect(() => {
    if (role !== 'camera') return
    const pc = peerContainerRef.current.pc
    if (!pc) return
    if (!localStream) {
      for (const sender of pc.getSenders()) {
        if (sender.track) {
          try { pc.removeTrack(sender) } catch { /* ignore */ }
        }
      }
      return
    }
    const existing = new Set(pc.getSenders().map((s) => s.track?.id))
    for (const track of localStream.getTracks()) {
      if (existing.has(track.id)) continue
      pc.addTrack(track, localStream)
    }
  }, [localStream, role])

  return { remoteStream, status, lastError, sendSignal }
}
