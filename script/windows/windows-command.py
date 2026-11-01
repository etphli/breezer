"""Run an explicit PowerShell file on the user's Tailscale build PC."""
import base64
import gzip
from pathlib import Path
import subprocess
import sys

def run_probe(script, timeout=60, remote_timeout=40):
    """Read-only probe with a deadline inside its own remote PowerShell process.

    A local SSH timeout alone leaves remote commands alive. Never use this for
    starting a detached task or for provisioning: its timer kills this process.
    """
    if not 0 < remote_timeout <= timeout - 15:
        raise ValueError('Reserve at least15seconds for SSH startup and cleanup')
    deadline = r'''
Add-Type -TypeDefinition 'using System; using System.Diagnostics; using System.Threading; public static class BreezerProbeDeadline { static Timer timer; public static void Arm(int ms) { timer = new Timer(_ => Process.GetCurrentProcess().Kill(), null, ms, Timeout.Infinite); } public static void Disarm() { timer.Dispose(); } }';
[BreezerProbeDeadline]::Arm(DEADLINE_MS);
try {
PROBE_BODY
} finally { [BreezerProbeDeadline]::Disarm() }
'''.replace('DEADLINE_MS', str(int(remote_timeout * 1000))).replace('PROBE_BODY', script)
    return run(deadline, timeout=timeout)

def run(script, timeout=60):
    prefix = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $OutputEncoding = [Console]::OutputEncoding;\n"
    text = prefix + script
    encoded = base64.b64encode(text.encode('utf-16le')).decode()
    if len(encoded) > 6500:
        payload = base64.b64encode(gzip.compress(text.encode('utf-8'))).decode()
        loader = "$m=[IO.MemoryStream]::new([Convert]::FromBase64String('" + payload + "'));$z=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($z);& ([scriptblock]::Create($r.ReadToEnd()))"
        encoded = base64.b64encode(loader.encode('utf-16le')).decode()
    assert len(encoded) < 7800, 'Use a smaller explicit script for Windows command-line limits'
    return subprocess.run([
        'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
        '-i', str(Path.home() / '.ssh/breezer_windows_ed25519'),
        '-o', 'ProxyCommand=/Users/likht.ethan/.local/share/remote-desks/tools/tailscale-1.104.1/bin/tailscale --socket=/Users/likht.ethan/.local/share/remote-desks/tailscaled.sock nc %h %p',
        'ethan@100.107.233.126',
        'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + encoded,
    ], capture_output=True, timeout=timeout)

if __name__ == '__main__':
    probe = sys.argv[1] == '--probe'
    path = sys.argv[2] if probe else sys.argv[1]
    result = run_probe(Path(path).read_text()) if probe else run(Path(path).read_text(), timeout=300)
    sys.stdout.write(result.stdout.decode('utf-8', errors='replace').replace('\x00', ''))
    sys.stderr.write(result.stderr.decode('utf-8', errors='replace').replace('\x00', ''))
    raise SystemExit(result.returncode)
