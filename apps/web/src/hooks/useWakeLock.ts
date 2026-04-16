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
    let sentinel: WakeLockSentinelLike | null = null
    const wakeLockApi = (navigator as NavigatorWithWakeLock).wakeLock

    if (!enabled || !wakeLockApi) {
      setIsActive(false)
      return
    }

    void wakeLockApi
      .request('screen')
      .then((lock) => {
        sentinel = lock
        setIsActive(true)
        lock.addEventListener?.('release', () => {
          setIsActive(false)
        })
      })
      .catch(() => {
        setIsActive(false)
      })

    return () => {
      if (sentinel && !sentinel.released) {
        void sentinel.release()
      }
      setIsActive(false)
    }
  }, [enabled])

  return { isActive }
}

