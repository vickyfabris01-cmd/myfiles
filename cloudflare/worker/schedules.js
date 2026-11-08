// cloudflare/worker/schedules.js
// Runs every minute from the cron trigger. SQL function is idempotent.
export async function runSchedules(db) {
  return db.rpc('apply_schedules', {});
}
