// Electron entry point: runs the build-manager console as a desktop app.
// In development it loads the Vite dev server; otherwise it loads the built files from dist/.
//
// The site twin and the site agent run in the edge service (services/edge). On a real site
// that's the edge server; for a one-laptop demo this app starts it too, unless something is
// already listening on the edge port (or EDGE_AUTOSTART=0).

const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const devServerUrl = process.env.VITE_DEV_SERVER_URL
const EDGE_PORT = Number(process.env.EDGE_PORT || 8765)
const edgeScript = path.join(__dirname, '..', '..', 'services', 'edge', 'run.sh')
let edgeProcess = null

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
}

async function startEdge() {
  if (process.env.EDGE_AUTOSTART === '0' || !fs.existsSync(edgeScript)) return
  if (await portInUse(EDGE_PORT)) return
  edgeProcess = spawn('bash', [edgeScript, '--port', String(EDGE_PORT)], { stdio: 'inherit', env: process.env })
  edgeProcess.on('exit', (code) => {
    if (code) console.error(`Edge service exited with code ${code}`)
    edgeProcess = null
  })
}

function stopEdge() {
  if (edgeProcess) edgeProcess.kill('SIGTERM')
  edgeProcess = null
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Site Twin',
    backgroundColor: '#dce2e4',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Keep the app on its own pages; open any outside link in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const isOwnPage = devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://')
    if (!isOwnPage) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  if (devServerUrl) {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(async () => {
  await startEdge()
  createWindow()
  // macOS: re-open a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopEdge)
