import { api, escapeHtml as e } from './incidents.js';
import { currentUser, sessionRequest } from './session.js';

export async function renderSettings(view) {
  view.classList.add('account-settings');
  const user = currentUser();
  view.innerHTML = `<header class="workspace-heading"><h2>Account & System</h2><button id="sign-out">Sign out</button></header><section class="triage-section"><h3>${e(user.name)}</h3><p>${e(user.username)} / ${e(user.roles.join(', '))}</p></section><div id="administration"></div>`;
  view.querySelector('#sign-out').onclick = async () => { await sessionRequest('/api/auth/logout', {}); window.location.reload(); };
  const passwordForm = document.createElement('form'); passwordForm.className = 'triage-section';
  passwordForm.innerHTML = '<h3>Change password</h3><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><p role="alert" class="form-error"></p><button type="submit">Change password</button>';
  view.querySelector('#administration').before(passwordForm);
  passwordForm.onsubmit = async event => {
    event.preventDefault(); const button = passwordForm.querySelector('button'); button.disabled = true;
    try { await sessionRequest('/api/auth/password', Object.fromEntries(new FormData(passwordForm))); window.location.reload(); }
    catch (error) { passwordForm.querySelector('[role=alert]').textContent = error.message; }
    finally { button.disabled = false; }
  };
  if (!user.roles.includes('admin')) return;
  const container = view.querySelector('#administration');
  const { users } = await api('/api/admin/users'), health = await api('/api/admin/health'), { events } = await api('/api/admin/audit');
  container.innerHTML = `<section class="triage-section"><h3>Runtime health</h3><dl>${Object.entries(health).map(([key, value]) => `<dt>${e(key)}</dt><dd>${e(typeof value === 'object' ? JSON.stringify(value) : String(value))}</dd>`).join('')}</dl></section><section class="triage-section"><h3>Users</h3><ul>${users.map(u => `<li><button type="button" data-user="${e(u.id)}">${e(u.name)}</button> ${e(u.username)} / ${e(u.roles.join(', '))} / ${u.disabled ? 'Disabled' : 'Active'}</li>`).join('')}</ul><form id="user-editor"><h4 id="editor-title">New user</h4><input name="id" type="hidden"><label>Username<input name="username" required pattern="[a-z0-9][a-z0-9._-]{2,63}" autocomplete="off"></label><label>Display name<input name="name" maxlength="100" required></label><label>Password<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password"></label><fieldset><legend>Roles</legend>${['admin', 'operator', 'expert', 'reviewer', 'viewer'].map(role => `<label><input type="checkbox" name="roles" value="${role}">${role}</label>`).join('')}</fieldset><label><input type="checkbox" name="disabled">Disabled</label><p role="alert" class="form-error"></p><button type="submit">Save user</button><button type="reset">New user</button></form></section><section class="triage-section"><h3>Recent audit events</h3><ul>${events.reverse().map(event => `<li>${e(event.at)} / ${e(event.method)} ${e(event.path)} / ${e(event.phase)} ${e(event.status || '')} / ${e(event.actorId || 'anonymous')}</li>`).join('')}</ul></section>`;
  const form = container.querySelector('form');
  container.querySelectorAll('[data-user]').forEach(button => { button.onclick = () => {
    const user = users.find(u => u.id === button.dataset.user);
    form.reset(); form.elements.id.value = user.id; form.elements.username.value = user.username; form.elements.username.readOnly = true; form.elements.name.value = user.name; form.elements.disabled.checked = user.disabled;
    form.querySelectorAll('[name=roles]').forEach(input => { input.checked = user.roles.includes(input.value); });
    form.querySelector('h4').textContent = 'Edit user'; form.scrollIntoView({ block: 'center' });
  }; });
  form.onreset = () => { form.elements.id.value = ''; form.elements.username.readOnly = false; form.querySelector('h4').textContent = 'New user'; };
  form.onsubmit = async event => {
    event.preventDefault(); const id = form.elements.id.value, data = Object.fromEntries(new FormData(form));
    data.roles = [...form.querySelectorAll('[name=roles]:checked')].map(input => input.value); data.disabled = form.elements.disabled.checked;
    if (id && !data.password) delete data.password;
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    try { await api(`/api/admin/users${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(data) }); if (id === user.id) window.location.reload(); else await renderSettings(view); }
    catch (error) { form.querySelector('[role=alert]').textContent = error.message; }
    finally { button.disabled = false; }
  };
}
