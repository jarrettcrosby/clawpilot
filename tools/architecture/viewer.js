// Intentionally offline: no imports, fetch, analytics, storage, or parent messaging.
(() => {
  const selector = document.getElementById('diagram-select')
  const theme = document.getElementById('theme-select')
  const views = [...document.querySelectorAll('[data-view]')]
  const appTheme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
  function applyTheme() { document.documentElement.dataset.theme = theme.value === 'app' ? appTheme : theme.value }
  function show(id, focus = false) {
    const view = views.find((item) => item.dataset.view === id) || views[0]
    selector.value = view.dataset.view
    for (const item of views) item.hidden = item !== view
    if (focus) view.querySelector('h1').focus({ preventScroll: true })
  }
  selector.addEventListener('change', () => { location.hash = selector.value; show(selector.value, true) })
  theme.addEventListener('change', applyTheme)
  window.addEventListener('hashchange', () => show(location.hash.slice(1)))
  show(location.hash.slice(1)); applyTheme()
})()
