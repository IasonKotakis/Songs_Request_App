// Starts the app on your computer: `npm start`, `node server.js`, or double-click start-windows.bat.
// For Cloudflare, see worker.js.

import os from 'node:os';
import { server } from './src/node-server.js';

const PORT = Number(process.env.PORT) || 3000;

// Addresses other devices on the same Wi-Fi can use (e.g. 192.168.1.23).
const lanAddresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a.address);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Is the app already running in another window?`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\n  Song requests app is running!\n');
  console.log(`  Guest page on this computer:    http://localhost:${PORT}`);
  console.log(`  DJ dashboard on this computer:  http://localhost:${PORT}/admin`);
  for (const ip of lanAddresses) {
    console.log(`  To test the QR code with a phone on the same Wi-Fi, open:  http://${ip}:${PORT}/admin`);
  }
  if (!process.env.ADMIN_KEY) console.log('\n  Dashboard password: changeme');
  console.log('\n  Keep this window open. Close it (or press Ctrl+C) to stop the app.\n');
});
