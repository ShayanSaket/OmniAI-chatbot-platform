// Runs once when the Next.js server starts: starts background jobs (Node.js runtime only).
// Set DISABLE_JOBS=true to run them elsewhere (e.g. a dedicated worker).
export async function register() {
  // This exact `if` lets Next drop the Node-only import from the edge bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.DISABLE_JOBS === 'true') return;
    const { startScheduler } = await import('./server/jobs/scheduler');
    startScheduler();
  }
}
