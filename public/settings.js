import { escapeHtml as e } from './incidents.js';
import { currentUser, sessionRequest } from './session.js';

const profile = { department: 'Asset Operations', workspace: 'Demo workspace' };

export async function renderSettings(view) {
  view.classList.add('account-settings');
  const user = currentUser();
  view.innerHTML = `<header class="workspace-heading"><h2>Settings</h2></header>
    <section class="settings-profile"><h3>Account</h3><dl><dt>Username</dt><dd>${e(user.username)}</dd><dt>Role</dt><dd>${e(user.roles.join(', '))}</dd></dl><button id="sign-out" type="button">Sign out</button><p role="alert" class="form-error" hidden></p></section>
    <section class="settings-profile"><h3>Personal information</h3><dl><dt>Name</dt><dd>${e(user.name)}</dd><dt>Department</dt><dd>${e(profile.department)}</dd><dt>Workspace</dt><dd>${e(profile.workspace)}</dd></dl></section>`;
  const button = view.querySelector('#sign-out');
  button.onclick = async () => {
    button.disabled = true;
    const error = view.querySelector('[role="alert"]'); error.hidden = true;
    try { await sessionRequest('/api/auth/logout', {}); window.location.reload(); }
    catch (failure) { error.textContent = failure.message; error.hidden = false; button.disabled = false; }
  };
}
