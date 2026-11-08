import { useEffect, useRef } from 'react'
import { edge } from '../edge/client'
import type { MeshSnapshot, PacketType } from '../mesh/types'

/** Mesh links (relay backbone, robot links, the hub's wire) and removed links, drawn under the assets. */
export function MeshLinks({ mesh, selectedId, k }: { mesh: MeshSnapshot; selectedId?: string; k: number }) {
  const pos = new Map(mesh.nodes.map((n) => [n.id, n]))
  const sel = selectedId ? pos.get(selectedId) : undefined
  const hub = pos.get('HUB')
  return (
    <g className="meshlayer" aria-hidden="true">
      {sel?.kind === 'robot' && <circle cx={sel.x} cy={sel.y} r={mesh.config.robotRangeM} className="robot-range" />}
      {mesh.links.map((l) => {
        const a = pos.get(l.a)
        const b = pos.get(l.b)
        if (!a || !b) return null
        const robot = a.kind === 'robot' || b.kind === 'robot'
        const touches = selectedId && (l.a === selectedId || l.b === selectedId)
        const cls = l.kind === 'wired' ? 'wired-link' : robot ? (a.kind === 'robot' && b.kind === 'robot' ? 'mesh-link mesh-link--r2r' : 'mesh-link mesh-link--robot') : 'mesh-link'
        return <line key={`${l.a}-${l.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`${cls} ${touches ? 'is-hot' : ''}`} />
      })}
      {mesh.cut.map(([ia, ib]) => {
        const a = pos.get(ia)
        const b = pos.get(ib)
        if (!a || !b) return null
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        return (
          <g key={`cut-${ia}-${ib}`} className="cut-link">
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <g transform={`translate(${mx} ${my}) scale(${k})`}>
              <circle r={8} />
              <path d="M-4 -4L4 4M4 -4L-4 4" />
            </g>
          </g>
        )
      })}
      {hub && (
        <g transform={`translate(${hub.x} ${hub.y}) scale(${k})`} className={`hub-mark ${mesh.hub.online ? '' : 'is-off'}`}>
          <circle r={15} />
          {!mesh.hub.online && <path d="M-9 -9L9 9M9 -9L-9 9" />}
          <text x={0} y={-20} textAnchor="middle" className="pin-label">{mesh.hub.online ? 'Hub' : 'Hub off'}</text>
        </g>
      )}
    </g>
  )
}

interface PacketProps {
  mesh: MeshSnapshot
  types: Set<PacketType>
  k: number
  /** Dim packets that aren't about this task. */
  taskId?: string
}

/**
 * Packets moving along the hops they actually took. Drawn imperatively from edge.traces
 * every animation frame, so it doesn't re-render React at 60 fps.
 */
export function PacketLayer({ mesh, types, k, taskId }: PacketProps) {
  const ref = useRef<SVGGElement>(null)
  const latest = useRef({ mesh, types, k, taskId })
  useEffect(() => {
    latest.current = { mesh, types, k, taskId }
  }, [mesh, types, k, taskId])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const g = ref.current
      if (!g) return
      const { mesh: m, types: ty, k: kk, taskId: tid } = latest.current
      const pos = new Map(m.nodes.map((n) => [n.id, n]))
      const now = Date.now()
      const r = 4.2 * kk
      let html = ''
      for (const t of edge.traces) {
        if (!ty.has(t.type)) continue
        const life = t.t1 - t.t0
        if (now < t.t0 || now > t.t1 + 450 || life <= 0) continue
        const a = pos.get(t.from)
        const b = pos.get(t.to)
        if (!a || !b) continue
        let p = Math.min(1, (now - t.t0) / life)
        let cls = `pkt pkt--${t.type}`
        let op = 1
        if (t.result === 'lost') {
          // Lost on the way: it gets halfway and fades out.
          if (p > 0.5) {
            op = Math.max(0, 1 - (p - 0.5) * 2.5)
            p = 0.5
          }
          cls += ' pkt--lost'
        } else if (t.result === 'broken') {
          cls += ' pkt--broken'
        } else if (now > t.t1) {
          op = Math.max(0, 1 - (now - t.t1) / 450)
          cls += ' pkt--arrived'
        }
        if (tid && t.taskId !== tid) op *= 0.18
        if (op <= 0.02) continue
        const x = a.x + (b.x - a.x) * p
        const y = a.y + (b.y - a.y) * p
        html += `<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(now > t.t1 && t.result === 'ok' ? r * 1.6 : r).toFixed(2)}" opacity="${op.toFixed(2)}"/>`
      }
      g.innerHTML = html
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <g ref={ref} className="packets" aria-hidden="true" />
}
