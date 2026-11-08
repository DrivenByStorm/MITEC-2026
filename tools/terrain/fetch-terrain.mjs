#!/usr/bin/env node
// Downloads real elevation data for the site and bundles it into the app.
//
// Source: AWS Terrain Tiles (Terrarium PNG), derived from USGS 3DEP (~10 m) in the US.
// Run this once on a machine with internet. The result, services/edge/data/site-dem.json,
// is loaded by the edge service, so the site itself never needs a connection.
//
//   cd tools/terrain && npm install
//   npm run fetch                      # default site in Pecos County, TX
//   npm run fetch -- --lat 30.79 --lon -103.03 --size-km 6 --cell 15
//   npm run fetch -- --tiles-dir ./my-tiles   # use tiles already on disk (z/x/y.png)

import { PNG } from 'pngjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = parseArgs(process.argv.slice(2))

const lat0 = num(args.lat, 30.79)
const lon0 = num(args.lon, -103.03)
const sizeKm = num(args['size-km'], 6)
const cellM = num(args.cell, 15)
const zoom = Math.round(num(args.zoom, 14))
const tilesDir = args['tiles-dir'] ? path.resolve(args['tiles-dir']) : null
const cacheDir = path.join(here, '.terrain-cache')
const outFile = path.resolve(args.out ?? path.join(here, '..', '..', 'services', 'edge', 'data', 'site-dem.json'))
const URL_TEMPLATE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

// ---------- geometry ----------

const rad = (d) => (d * Math.PI) / 180
// Meters per degree at this latitude (WGS84 series), for a local flat-earth frame around the site.
const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * rad(lat0)) + 1.175 * Math.cos(4 * rad(lat0))
const mPerDegLon = 111412.84 * Math.cos(rad(lat0)) - 93.5 * Math.cos(3 * rad(lat0))

const worldPx = 256 * 2 ** zoom
const lonToPx = (lon) => ((lon + 180) / 360) * worldPx
const latToPx = (lat) => ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * worldPx

const cols = Math.round((sizeKm * 1000) / cellM)
const rows = cols
const half = (cols * cellM) / 2

// Site frame: x east, y south, origin at the NW corner; the site center is (lat0, lon0).
function cellToLatLon(c, r) {
  const x = (c + 0.5) * cellM - half
  const y = (r + 0.5) * cellM - half
  return { lat: lat0 - y / mPerDegLat, lon: lon0 + x / mPerDegLon }
}

// ---------- tiles ----------

const tiles = new Map()

async function loadTile(tx, ty) {
  const key = `${tx}/${ty}`
  if (tiles.has(key)) return tiles.get(key)
  let buf
  if (tilesDir) {
    buf = fs.readFileSync(path.join(tilesDir, String(zoom), String(tx), `${ty}.png`))
  } else {
    const cached = path.join(cacheDir, String(zoom), String(tx), `${ty}.png`)
    if (fs.existsSync(cached)) {
      buf = fs.readFileSync(cached)
    } else {
      const url = URL_TEMPLATE.replace('{z}', zoom).replace('{x}', tx).replace('{y}', ty)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`)
      buf = Buffer.from(await res.arrayBuffer())
      fs.mkdirSync(path.dirname(cached), { recursive: true })
      fs.writeFileSync(cached, buf)
    }
  }
  const png = PNG.sync.read(buf)
  tiles.set(key, png)
  return png
}

// Terrarium decoding: elevation (m) = R*256 + G + B/256 - 32768
function heightAt(png, px, py) {
  const i = (py * png.width + px) * 4
  return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768
}

function samplePixel(gx, gy) {
  const tx = Math.floor(gx / 256)
  const ty = Math.floor(gy / 256)
  const png = tiles.get(`${tx}/${ty}`)
  return heightAt(png, Math.floor(gx) - tx * 256, Math.floor(gy) - ty * 256)
}

// Bilinear sample between pixel centers (works across tile edges).
function sample(gx, gy) {
  const x = gx - 0.5
  const y = gy - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const h00 = samplePixel(x0, y0)
  const h10 = samplePixel(x0 + 1, y0)
  const h01 = samplePixel(x0, y0 + 1)
  const h11 = samplePixel(x0 + 1, y0 + 1)
  return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy
}

// ---------- main ----------

async function main() {
  const nw = cellToLatLon(-1, -1)
  const se = cellToLatLon(cols, rows)
  const tx0 = Math.floor((lonToPx(nw.lon) - 1) / 256)
  const tx1 = Math.floor((lonToPx(se.lon) + 1) / 256)
  const ty0 = Math.floor((latToPx(nw.lat) - 1) / 256)
  const ty1 = Math.floor((latToPx(se.lat) + 1) / 256)
  const count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)

  console.log(`Site center ${lat0}, ${lon0}; ${sizeKm} km square at ${cellM} m cells (${cols}×${rows}).`)
  console.log(`${tilesDir ? 'Reading' : 'Fetching'} ${count} terrain tiles at zoom ${zoom}...`)
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) await loadTile(tx, ty)

  const dm = new Int16Array(cols * rows) // decimeters
  let min = Infinity
  let max = -Infinity
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const { lat, lon } = cellToLatLon(c, r)
      const h = sample(lonToPx(lon), latToPx(lat))
      dm[r * cols + c] = Math.round(h * 10)
      min = Math.min(min, h)
      max = Math.max(max, h)
    }
  }

  const out = {
    version: 1,
    source: 'AWS Terrain Tiles (Terrarium)',
    attribution: 'Elevation: AWS Terrain Tiles, derived from USGS 3DEP and SRTM',
    lat0,
    lon0,
    cellM,
    cols,
    rows,
    zoom,
    fetchedAt: new Date().toISOString(),
    heightsDm: Buffer.from(dm.buffer).toString('base64'),
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out))
  console.log(`Elevation ${min.toFixed(1)}–${max.toFixed(1)} m (relief ${(max - min).toFixed(1)} m).`)
  console.log(`Wrote ${path.relative(process.cwd(), outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB). Restart the app to use it.`)
}

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) {
      const key = list[i].slice(2)
      const next = list[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    }
  }
  return out
}

function num(v, fallback) {
  const n = Number(v)
  return v === undefined || Number.isNaN(n) ? fallback : n
}

main().catch((err) => {
  console.error(`Terrain fetch failed: ${err.message}`)
  console.error('Check your internet connection, or pass --tiles-dir with tiles you already have.')
  process.exit(1)
})
