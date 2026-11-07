// Electron entry point: runs the build-manager console as a desktop app.
// In development it loads the Vite dev server; otherwise it loads the built
// files from dist/, so the app works with no network connection at all.

const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')

const devServerUrl = process.env.VITE_DEV_SERVER_URL

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

app.whenReady().then(() => {
  createWindow()
  // macOS: re-open a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
