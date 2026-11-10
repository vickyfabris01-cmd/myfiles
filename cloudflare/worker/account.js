// cloudflare/worker/account.js
// PATCH /admin/account  { name }   a host sets or changes the name shown to the owner next to their email.
import { ApiError, v, readJson } from './utils.js';

export async function rename({ request, db, admin }) {
  const b = await readJson(request);
  const name = v.str(b.name, 'name', { min: 1, max: 80 });
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ApiError(400, 'VALIDATION_ERROR', 'The name contains characters that are not allowed');
  await db.update('profiles', { user_id: `eq.${admin.id}` }, { display_name: name, updated_at: new Date().toISOString() });
  return { name };
}
