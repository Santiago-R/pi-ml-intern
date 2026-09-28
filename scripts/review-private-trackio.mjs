import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Never infer an account or a machine-specific Python environment.
const python = process.env.ML_TRACKIO_PYTHON || 'python3';
const script = fileURLToPath(new URL('./review-private-trackio.py', import.meta.url));
const child = spawn(python, [script, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', error => {
  console.error(`Could not start Python: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
