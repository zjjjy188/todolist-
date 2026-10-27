const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, 'data.json');

contextBridge.exposeInMainWorld('widget', {
  getBounds: () => ipcRenderer.invoke('widget:getBounds'),
  setBounds: (b) => ipcRenderer.send('widget:setBounds', b),
  fit: (size) => ipcRenderer.send('widget:fit', size),
  collapse: () => ipcRenderer.send('widget:collapse'),
  expand: () => ipcRenderer.send('widget:expand'),
  beginDrag: () => ipcRenderer.send('widget:beginDrag'),
  endDrag: () => ipcRenderer.send('widget:endDrag'),
  peek: (show) => ipcRenderer.send('widget:peek', !!show),
  quit: () => ipcRenderer.send('widget:quit'),
  onMode: (fn) => {
    ipcRenderer.on('widget:mode', (e, mode, extra) => fn(mode, extra || {}));
  },
  readData: () => {
    try { return fs.readFileSync(dataFile, 'utf8'); } catch (e) { return null; }
  },
  writeData: (txt) => {
    try { fs.writeFileSync(dataFile, txt, 'utf8'); } catch (e) {}
  }
});
