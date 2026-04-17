// Fixed-size LRU keyed by idempotencyKey. 200 slots ≈ ~5 minutes of alert
// traffic at the per-recipient 15 s cooldown. Home-LAN scale — no need to
// persist across restarts.
export class IdempotencyLru {
  private readonly capacity: number
  private readonly store = new Map<string, number>()

  constructor(capacity = 200) {
    this.capacity = capacity
  }

  has(key: string): boolean {
    if (!this.store.has(key)) return false
    const value = this.store.get(key)!
    this.store.delete(key)
    this.store.set(key, value)
    return true
  }

  add(key: string): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.capacity) {
      const first = this.store.keys().next().value
      if (first !== undefined) this.store.delete(first)
    }
    this.store.set(key, Date.now())
  }
}

export class PerRecipientCooldown {
  private readonly windowMs: number
  private readonly last = new Map<string, number>()

  constructor(windowMs = 15_000) {
    this.windowMs = windowMs
  }

  check(recipient: string, now = Date.now()): { ok: boolean; retryInMs: number } {
    const last = this.last.get(recipient)
    if (last === undefined) return { ok: true, retryInMs: 0 }
    const elapsed = now - last
    if (elapsed >= this.windowMs) return { ok: true, retryInMs: 0 }
    return { ok: false, retryInMs: this.windowMs - elapsed }
  }

  mark(recipient: string, now = Date.now()): void {
    this.last.set(recipient, now)
  }
}
