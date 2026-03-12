/**
 * ============================================================
 * HD Import Suite — Launcher
 * ============================================================
 * Startet die unified App:
 *   → http://localhost:3737
 * ============================================================
 */

const { spawn } = require('child_process');
const path = require('path');

let intentionalStop = false;

function start() {
  if (intentionalStop) return;
  const proc = spawn('node', [path.join(__dirname, 'hd_server.js')], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  proc.on('exit', code => {
    if (intentionalStop) { process.exit(0); return; }
    if (code !== 0) {
      console.error(`\n[start.js] Server exited with code ${code} — restarting in 1s…`);
      setTimeout(start, 1000);
    } else {
      process.exit(0);
    }
  });
  process.on('SIGINT', () => { intentionalStop = true; proc.kill(); process.exit(0); });
}

start();
