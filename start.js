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

const proc = spawn('node', [path.join(__dirname, 'hd_server.js')], {
  stdio: 'inherit',
  cwd: __dirname,
});

proc.on('exit', code => process.exit(code));
process.on('SIGINT', () => { proc.kill(); process.exit(0); });
