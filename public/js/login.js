const $ = selector => document.querySelector(selector);

export function setupLogin({ authenticate, onAuthenticated }) {
  const form = $('#login-form');
  const helpButton = $('#login-help-toggle');

  form?.addEventListener('submit', async event => {
    event.preventDefault();

    const button = form.querySelector('button[type="submit"]');
    const buttonText = button?.querySelector('.login-submit-text');
    const password = $('#login-password');
    const error = $('#login-error');

    if (error) error.textContent = '';
    form.classList.remove('login-error-shake');
    if (button) button.disabled = true;
    if (buttonText) buttonText.textContent = 'Signing in…';

    try {
      await authenticate(password?.value || '');
      await onAuthenticated();
      if (password) password.value = '';
    } catch (requestError) {
      if (error) error.textContent = requestError?.message || 'Unable to sign in';
      form.classList.add('login-error-shake');
      window.setTimeout(() => form.classList.remove('login-error-shake'), 420);
    } finally {
      if (button) button.disabled = false;
      if (buttonText) buttonText.textContent = 'Sign in';
    }
  });

  helpButton?.addEventListener('click', () => {
    const panel = $('#login-help-panel');
    if (!panel) return;
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    helpButton.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });
}
