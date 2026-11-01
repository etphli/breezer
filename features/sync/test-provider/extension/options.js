document.getElementById('configuration').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('token');
  const result = document.getElementById('result');
  try {
    const token = input.value.trim();
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error('Enter the token from the disposable provider token file.');
    await chrome.storage.local.set({ testProviderToken: token });
    input.value = '';
    result.textContent = 'Token saved locally. Configure sync in the native Breezer setup page when available.';
  } catch (error) {
    result.textContent = error.message || 'Could not save the test token.';
  }
});
