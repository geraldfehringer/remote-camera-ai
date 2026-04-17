import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'alerts-muted'

type ToneStep = {
  freq: number
  dur: number
  delay: number
  type: OscillatorType
  gain?: number
}

// Distinct waveform + pitch + rhythm signatures per target so the listener
// can tell "bird!" from "person!" from across the room without looking.
const PATTERNS: Record<string, ToneStep[]> = {
  // Bird: bright chirp trill — two quick rising notes
  bird: [
    { freq: 1200, dur: 0.07, delay: 0.0, type: 'sine' },
    { freq: 1800, dur: 0.07, delay: 0.09, type: 'sine' },
    { freq: 1500, dur: 0.1, delay: 0.19, type: 'sine' },
  ],
  // Cat: low warm two-tone descending (feels calm + furry)
  cat: [
    { freq: 320, dur: 0.18, delay: 0.0, type: 'triangle', gain: 0.8 },
    { freq: 240, dur: 0.28, delay: 0.19, type: 'triangle', gain: 0.8 },
  ],
  // Squirrel: three rapid staccato clicks + one higher
  squirrel: [
    { freq: 1800, dur: 0.035, delay: 0.0, type: 'square', gain: 0.45 },
    { freq: 1800, dur: 0.035, delay: 0.07, type: 'square', gain: 0.45 },
    { freq: 1800, dur: 0.035, delay: 0.14, type: 'square', gain: 0.45 },
    { freq: 2400, dur: 0.06, delay: 0.22, type: 'square', gain: 0.45 },
  ],
  // Person: urgent two-tone alarm (serious, a bit louder)
  person: [
    { freq: 880, dur: 0.13, delay: 0.0, type: 'sawtooth', gain: 0.9 },
    { freq: 660, dur: 0.13, delay: 0.15, type: 'sawtooth', gain: 0.9 },
    { freq: 880, dur: 0.13, delay: 0.3, type: 'sawtooth', gain: 0.9 },
    { freq: 660, dur: 0.13, delay: 0.45, type: 'sawtooth', gain: 0.9 },
  ],
  // Motion-only / generic: neutral two-tone ping
  'motion-only': [
    { freq: 880, dur: 0.1, delay: 0.0, type: 'sine' },
    { freq: 1100, dur: 0.12, delay: 0.12, type: 'sine' },
  ],
}

const DEFAULT_PATTERN = PATTERNS['motion-only']

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, muted ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/**
 * Per-category audio alert hook.
 *
 * - Synthesizes distinct tone patterns via Web Audio; no .mp3 assets needed.
 * - Honours autoplay policy: creates/resumes the AudioContext on the first
 *   user gesture (click/keydown) and then stays ready.
 * - Persists the mute toggle in localStorage.
 * - `play` is a no-op when muted or when the browser hasn't unlocked audio
 *   yet (i.e. user never interacted with the page).
 */
export function useAlertSound() {
  const [muted, setMuted] = useState<boolean>(readMuted)
  const [ready, setReady] = useState<boolean>(false)
  const ctxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    const unlock = () => {
      if (!ctxRef.current) {
        type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext }
        const AudioCtx =
          window.AudioContext ?? (window as WebkitWindow).webkitAudioContext
        if (AudioCtx) {
          try {
            ctxRef.current = new AudioCtx()
          } catch {
            return
          }
        }
      }
      const ctx = ctxRef.current
      if (ctx?.state === 'suspended') {
        void ctx.resume()
      }
      setReady(ctx?.state === 'running' || ctx?.state === 'suspended')
    }
    document.addEventListener('click', unlock)
    document.addEventListener('keydown', unlock)
    document.addEventListener('touchstart', unlock, { passive: true })
    return () => {
      document.removeEventListener('click', unlock)
      document.removeEventListener('keydown', unlock)
      document.removeEventListener('touchstart', unlock)
    }
  }, [])

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev
      writeMuted(next)
      return next
    })
  }, [])

  const play = useCallback(
    (target: string) => {
      if (muted) return
      const ctx = ctxRef.current
      if (!ctx || ctx.state !== 'running') return
      const pattern = PATTERNS[target.toLowerCase()] ?? DEFAULT_PATTERN
      const now = ctx.currentTime
      const master = ctx.createGain()
      master.gain.value = 0.28
      master.connect(ctx.destination)
      for (const step of pattern) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = step.type
        osc.frequency.value = step.freq
        osc.connect(gain)
        gain.connect(master)
        const start = now + step.delay
        const end = start + step.dur
        const peak = step.gain ?? 0.6
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(peak, start + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.001, end)
        osc.start(start)
        osc.stop(end + 0.02)
      }
    },
    [muted]
  )

  return { muted, ready, toggleMute, play }
}
