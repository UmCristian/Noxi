const field = document.getElementById('key');
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light';
const toggle = document.getElementById('toggle-password');
const error = document.getElementById('login-error');
const params = new URLSearchParams(location.search);
if (params.has('error') || params.has('setup')) {
  error.hidden = false;
  error.textContent = params.has('setup')
    ? 'The site access key is not configured. Set PASS_KEY on the server.'
    : 'Incorrect access key. Try again.';
  if (params.has('error')) field.setAttribute('aria-invalid', 'true');
}
toggle.addEventListener('click', () => {
  const visible = field.type === 'password';
  field.type = visible ? 'text' : 'password';
  toggle.textContent = visible ? 'Hide' : 'Show';
  toggle.setAttribute('aria-label', visible ? 'Hide key' : 'Show key');
  toggle.setAttribute('aria-pressed', String(visible));
});
field.addEventListener('input', () => field.removeAttribute('aria-invalid'));
