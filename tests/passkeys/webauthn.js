/* Test fixture only. Returns public WebAuthn responses, never private keys. */
let pending;
let credentialId;
const challenge = () => crypto.getRandomValues(new Uint8Array(32));
const bytes = value => Array.from(new Uint8Array(value));
window.passkeyFixture = {
  async create(rpId = location.hostname) {
    pending = new AbortController();
    const nonce = challenge();
    const credential = await navigator.credentials.create({ signal: pending.signal, publicKey: {
      challenge: nonce,
      rp: { id: rpId, name: 'Breezer disposable fixture' },
      user: { id: new Uint8Array([1, 2, 3, 4]), name: 'breezer-test@example.test', displayName: 'Disposable dummy' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
    } });
    credentialId = bytes(credential.rawId);
    return { id: credential.id, rawId: credentialId, challenge: bytes(nonce),
      clientData: bytes(credential.response.clientDataJSON), publicKey: bytes(credential.response.getPublicKey()) };
  },
  async use({ rpId = location.hostname, conditional = false, id = credentialId } = {}) {
    pending = new AbortController();
    const nonce = challenge();
    const credential = await navigator.credentials.get({ signal: pending.signal,
      ...(conditional ? { mediation: 'conditional' } : {}), publicKey: {
        challenge: nonce, rpId, userVerification: 'required',
        allowCredentials: conditional ? [] : [{ type: 'public-key', id: new Uint8Array(id) }],
      } });
    return { id: credential.id, challenge: bytes(nonce), clientData: bytes(credential.response.clientDataJSON),
      authenticatorData: bytes(credential.response.authenticatorData), signature: bytes(credential.response.signature) };
  },
  cancel() { pending?.abort(); },
};
const show = async operation => {
  document.getElementById('result').textContent = 'Waiting for authenticator...';
  try {
    await operation();
    document.getElementById('result').textContent = 'Completed dummy request';
  } catch (error) {
    document.getElementById('result').textContent = error.name;
  }
};
document.getElementById('create').onclick = () => show(() => passkeyFixture.create());
document.getElementById('use').onclick = () => show(() => passkeyFixture.use());
document.getElementById('conditional').onclick = () => show(() => passkeyFixture.use({ conditional: true }));
document.getElementById('cancel').onclick = () => passkeyFixture.cancel();
