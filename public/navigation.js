// Same-page links must not trigger the router's popstate re-render.
export function jumpToSection(event, root) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const link = event.target.closest('a[href^="#"]');
  if (!link || link.target || link.hasAttribute('download')) return false;
  let id;
  try { id = decodeURIComponent(link.getAttribute('href').slice(1)); } catch { return false; }
  const target = root.getElementById(id);
  if (!target) return false;
  event.preventDefault();
  for (let parent = target; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  target.scrollIntoView({ behavior: 'instant', block: 'start' });
  return true;
}
