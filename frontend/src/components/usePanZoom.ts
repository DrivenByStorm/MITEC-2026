import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

/** Drag-to-pan and wheel-to-zoom for an SVG map, plus click detection that ignores drags. */
export function usePanZoom(fit: ViewBox, onClick: (target: Element, e: ReactPointerEvent) => void) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [vb, setVb] = useState<ViewBox>(fit)
  const [px, setPx] = useState({ w: 1000, h: 600 })
  const drag = useRef<{ x: number; y: number; vb: ViewBox; moved: boolean } | null>(null)
  const minW = fit.w / 10
  const maxW = fit.w * 1.4

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const ro = new ResizeObserver(([entry]) => setPx({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const pt = toSvgPoint(svg, e.clientX, e.clientY)
      const factor = Math.exp(e.deltaY * 0.0015)
      setVb((cur) => {
        const w = clamp(cur.w * factor, minW, maxW)
        const h = (cur.h * w) / cur.w
        return { x: pt.x - ((pt.x - cur.x) * w) / cur.w, y: pt.y - ((pt.y - cur.y) * h) / cur.h, w, h }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [minW, maxW])

  const handlers = {
    onPointerDown: (e: ReactPointerEvent) => {
      drag.current = { x: e.clientX, y: e.clientY, vb, moved: false }
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const d = drag.current
      const svg = svgRef.current
      if (!d || !svg) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (Math.hypot(dx, dy) > 4) d.moved = true
      if (!d.moved) return
      const rect = svg.getBoundingClientRect()
      const scale = Math.max(d.vb.w / rect.width, d.vb.h / rect.height)
      setVb({ ...d.vb, x: d.vb.x - dx * scale, y: d.vb.y - dy * scale })
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const d = drag.current
      drag.current = null
      if (d && !d.moved) {
        // Pointer capture retargets the event to the svg, so find what was under the pointer.
        const hit = document.elementFromPoint(e.clientX, e.clientY)
        onClick(hit ?? (e.target as Element), e)
      }
    },
  }

  const zoomBy = (f: number) =>
    setVb((cur) => {
      const w = clamp(cur.w * f, minW, maxW)
      const h = (cur.h * w) / cur.w
      return { x: cur.x + (cur.w - w) / 2, y: cur.y + (cur.h - h) / 2, w, h }
    })

  const pxPerUnit = Math.min(px.w / vb.w, px.h / vb.h) || 1
  const zoom = fit.w / vb.w
  const toSvg = (clientX: number, clientY: number) => (svgRef.current ? toSvgPoint(svgRef.current, clientX, clientY) : { x: 0, y: 0 })

  return { svgRef, vb, setVb, px, pxPerUnit, zoom, handlers, zoomBy, toSvg }
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function toSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const m = svg.getScreenCTM()
  return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 }
}
