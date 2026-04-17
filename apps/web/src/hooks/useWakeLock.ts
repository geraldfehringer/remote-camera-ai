import { useEffect, useState } from 'react'

type WakeLockSentinelLike = {
  released: boolean
  release: () => Promise<void>
  addEventListener?: (type: 'release', listener: () => void) => void
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>
  }
}

export function useWakeLock(enabled: boolean) {
  const [isActive, setIsActive] = useState(false)

  useEffect(() => {
    const wakeLockApi = (navigator as NavigatorWithWakeLock).wakeLock
    if (!enabled || !wakeLockApi) {
      setIsActive(false)
      return
    }

    let sentinel: WakeLockSentinelLike | null = null
    let cancelled = false

    // The Screen Wake Lock spec requires the document to be visible for a
    // lock to be held. Chrome Android also silently releases the lock when
    // the tab goes background or the screen locks. Our job is to keep
    // re-acquiring it whenever we regain visibility.
    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (sentinel && !sentinel.released) return
      try {
        const lock = await wakeLockApi.request('screen')
        if (cancelled) {
          void lock.release()
          return
        }
        sentinel = lock
        setIsActive(true)
        lock.addEventListener?.('release', () => {
          setIsActive(false)
          sentinel = null
          // If the user is still streaming, try to re-acquire on next visibility.
          if (!cancelled && document.visibilityState === 'visible') {
            void acquire()
          }
        })
      } catch {
        setIsActive(false)
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void acquire()
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (sentinel && !sentinel.released) {
        void sentinel.release()
      }
      setIsActive(false)
    }
  }, [enabled])

  return { isActive }
}

