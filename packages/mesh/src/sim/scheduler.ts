// Discrete-event scheduler. Simulation time is in milliseconds from the start of the run;
// every node reads time from here, so the whole mesh can run faster or slower than real time.

type Job = { t: number; seq: number; fn: () => void; cancelled?: boolean }

export class Scheduler {
  now = 0
  /** GPS time (ms, UTC) at sim time 0. */
  readonly epoch: number
  private heap: Job[] = []
  private seq = 0

  constructor(epoch = Date.now()) {
    this.epoch = epoch
  }

  get gpsTime() {
    return this.epoch + Math.round(this.now)
  }

  /** Run fn after delay ms. Returns a handle that can be cancelled. */
  after(delay: number, fn: () => void): Job {
    const job: Job = { t: this.now + Math.max(0, delay), seq: this.seq++, fn }
    this.push(job)
    return job
  }

  /** Run fn every interval ms (with optional ± jitter), starting after the first interval. */
  every(interval: number, fn: () => void, jitter = 0, rand: () => number = Math.random): { cancel(): void } {
    let stopped = false
    let job: Job
    const next = () => interval + (jitter ? (rand() * 2 - 1) * jitter : 0)
    const tick = () => {
      if (stopped) return
      fn()
      if (!stopped) job = this.after(next(), tick)
    }
    job = this.after(next() * rand(), tick) // stagger the first run so nodes don't fire in lockstep
    return {
      cancel: () => {
        stopped = true
        job.cancelled = true
      },
    }
  }

  cancel(job: Job | undefined) {
    if (job) job.cancelled = true
  }

  /** Advance simulation time to `until`, running every job that falls due. */
  runUntil(until: number) {
    while (this.heap.length && this.heap[0].t <= until) {
      const job = this.pop()!
      if (job.cancelled) continue
      this.now = job.t
      job.fn()
    }
    this.now = until
  }

  get pending() {
    return this.heap.length
  }

  private push(job: Job) {
    const h = this.heap
    h.push(job)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.less(h[p], h[i])) break
      ;[h[p], h[i]] = [h[i], h[p]]
      i = p
    }
  }

  private pop(): Job | undefined {
    const h = this.heap
    if (!h.length) return undefined
    const top = h[0]
    const last = h.pop()!
    if (h.length) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < h.length && this.less(h[l], h[m])) m = l
        if (r < h.length && this.less(h[r], h[m])) m = r
        if (m === i) break
        ;[h[m], h[i]] = [h[i], h[m]]
        i = m
      }
    }
    return top
  }

  private less(a: Job, b: Job) {
    return a.t < b.t || (a.t === b.t && a.seq < b.seq)
  }
}

/** Deterministic random numbers (LCG), so a run can be replayed from its seed. */
export function seededRandom(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}
