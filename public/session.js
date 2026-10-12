let session = { user: null, csrf: null };
export const currentUser = () => session.user;
export const csrfHeaders = () => session.csrf ? { 'X-CSRF-Token': session.csrf } : {};
export function bindAccountIdentity(root) {
  if (!session.user) return;
  root.querySelectorAll('input[name="reviewer"], input[name="actor"], input[name="author"]').forEach(input => {
    input.value = session.user.name; input.readOnly = true; input.title = 'Signed-in account';
  });
}
export async function sessionRequest(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Authentication failed.');
  if (Object.hasOwn(result, 'user')) session = result;
  return result;
}
export async function requireSession(root) {
  await sessionRequest('/api/auth/session');
  if (session.user) return true;
  root.innerHTML = '<section class="triage-section"><h2>Sign in</h2><form id="sign-in" class="account-form"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p role="alert" class="form-error"></p><button type="submit" class="primary">Sign in</button></form></section>';
  const form = root.querySelector('form');
  form.onsubmit = async event => {
    event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
    try { await sessionRequest('/api/auth/login', Object.fromEntries(new FormData(form))); window.location.reload(); }
    catch (error) { form.querySelector('[role=alert]').textContent = error.message; }
    finally { button.disabled = false; }
  };
  return false;
}
