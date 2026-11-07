// Terrain the survey drones "discover".
//
// If src/survey/data/site-dem.json exists (created by `npm run terrain:fetch`), the survey
// reveals real elevation data. Otherwise it falls back to generated terrain and says so in
// the UI, so nobody mistakes it for a real site.

export interface Terrain {
  cols: number
  rows: number
  cellM: number
  lat0: number
  lon0: number
  real: boolean
  sourceLabel: string
  heights: Float32Array // meters, row-major, row 0 = north edge
}

interface DemFile {
  version: number
  source: string
  attribution: string
  lat0: number
  lon0: number
  cellM: number
  cols: number
  rows: number
  heightsDm: string
}

// Eager glob: resolves to {} when the file hasn't been fetched yet.
const files = import.meta.glob<DemFile>('./data/site-dem.json', { eager: true, import: 'default' })

let cached: Terrain | null = null

export function loadTerrain(): Terrain {
  if (cached) return cached
  const dem = Object.values(files)[0]
  cached = dem ? decode(dem) : synthetic()
  return cached
}

function decode(dem: DemFile): Terrain {
  const bin = atob(dem.heightsDm)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const dm = new Int16Array(bytes.buffer)
  const heights = new Float32Array(dm.length)
  for (let i = 0; i < dm.length; i++) heights[i] = dm[i] / 10
  return {
    cols: dem.cols,
    rows: dem.rows,
    cellM: dem.cellM,
    lat0: dem.lat0,
    lon0: dem.lon0,
    real: true,
    sourceLabel: `Real terrain near ${dem.lat0.toFixed(3)}, ${dem.lon0.toFixed(3)}. ${dem.attribution}.`,
    heights,
  }
}

/** Plausible West Texas terrain: gentle slope, rolling ground, a mesa and a dry wash. */
function synthetic(): Terrain {
  const cols = 400
  const rows = 400
  const cellM = 15
  const heights = new Float32Array(cols * rows)
  const noise = valueNoise(11)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c / cols
      const y = r / rows
      let h = 905 + (0.5 - x) * 28 + (y - 0.5) * 12 // regional tilt
      h += fbm(noise, x * 5, y * 5) * 22
      // mesa to the north-east
      const dm = Math.hypot((x - 0.72) * 1.4, y - 0.28)
      h += 34 / (1 + Math.exp((dm - 0.11) * 60))
      // dry wash running roughly north-south, west of center
      const wash = Math.abs(x - (0.32 + Math.sin(y * 7) * 0.04))
      h -= 7 * Math.exp(-((wash / 0.018) ** 2))
      heights[r * cols + c] = h
    }
  }
  return {
    cols,
    rows,
    cellM,
    lat0: 30.79,
    lon0: -103.03,
    real: false,
    sourceLabel: 'Synthetic terrain for the demo. Run "npm run terrain:fetch" to load real elevation data.',
    heights,
  }
}

function valueNoise(seed: number) {
  const size = 256
  const perm = new Uint8Array(size * 2)
  const vals = new Float32Array(size)
  let s = seed
  const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
  for (let i = 0; i < size; i++) {
    perm[i] = i
    vals[i] = rand() * 2 - 1
  }
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[perm[i], perm[j]] = [perm[j], perm[i]]
  }
  for (let i = 0; i < size; i++) perm[i + size] = perm[i]
  const lattice = (ix: number, iy: number) => vals[perm[(perm[ix & 255] + iy) & 255]]
  return (x: number, y: number) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = lattice(ix, iy) + (lattice(ix + 1, iy) - lattice(ix, iy)) * sx
    const b = lattice(ix, iy + 1) + (lattice(ix + 1, iy + 1) - lattice(ix, iy + 1)) * sx
    return a + (b - a) * sy
  }
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number) {
  let total = 0
  let amp = 0.5
  let freq = 1
  for (let o = 0; o < 4; o++) {
    total += noise(x * freq, y * freq) * amp
    amp *= 0.5
    freq *= 2
  }
  return total
}
