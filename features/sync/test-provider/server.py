#!/usr/bin/env python3
"""Disposable loopback CAS provider for the inherited syncVaultProvider API.

This is a test transport, not a hosted sync service. It stores opaque ciphertext
and revisions only. Native Breezer owns encryption, keys and journal validation.
"""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from urllib.parse import unquote, urlsplit

MAX_BYTES = 64 * 1024 * 1024
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
OBJECT = re.compile(r"(?:head|[a-zA-Z0-9_-]{1,160})")


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        with self.connect() as connection:
            connection.executescript("""
                CREATE TABLE vaults (id TEXT PRIMARY KEY, name TEXT NOT NULL);
                CREATE TABLE objects (
                    vault TEXT NOT NULL REFERENCES vaults(id),
                    id TEXT NOT NULL, revision TEXT NOT NULL, data BLOB NOT NULL,
                    epoch INTEGER, PRIMARY KEY(vault, id));
            """)

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute('PRAGMA foreign_keys=ON')
        return connection

    @classmethod
    def reopen(cls, path):
        # An explicit restart may open only a regular private provider file.
        path = Path(path)
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError('Existing provider database must be a private regular file')
        instance = cls.__new__(cls)
        instance.path = path
        with instance.connect() as connection:
            connection.execute('SELECT id, name FROM vaults LIMIT 1')
            connection.execute('SELECT vault, id, revision, data, epoch FROM objects LIMIT 1')
        return instance


def make_server(store, token, port=0):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # URLs and authorization must never enter request logs.

        def reply(self, status, data=b'', revision=None, json_data=False):
            if json_data:
                data = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Content-Type', 'application/json' if json_data else 'application/octet-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if revision:
                self.send_header('ETag', revision)
            self.end_headers()
            self.wfile.write(data)

        def handle_request(self):
            # No remote bind, CORS, cookies, query tokens or plaintext key API.
            if not hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {token}'):
                self.reply(401)
                return
            parsed = urlsplit(self.path)
            if parsed.query or parsed.fragment:
                self.reply(400)
                return
            path = parsed.path.split('/')
            try:
                if self.command == 'GET' and path == ['', 'health']:
                    self.reply(200, {'version': 1}, json_data=True)
                    return
                if self.command == 'GET' and path == ['', 'v1', 'vaults']:
                    with store.connect() as connection:
                        rows = connection.execute('SELECT id, name FROM vaults ORDER BY id').fetchall()
                    self.reply(200, [{'vaultUuid': id_, 'displayName': name} for id_, name in rows], json_data=True)
                    return
                if len(path) not in (4, 6) or path[1:3] != ['v1', 'vaults'] or not UUID.fullmatch(path[3]):
                    self.reply(404)
                    return
                vault = path[3]
                if self.command in ('PUT', 'POST'):
                    length = self.headers.get('Content-Length', '')
                    if not length.isdigit() or int(length) > MAX_BYTES:
                        self.reply(413)
                        return
                    data = self.rfile.read(int(length))
                    if len(data) != int(length):
                        self.reply(400)
                        return
                with store.connect() as connection:
                    if len(path) == 4 and self.command == 'PUT':
                        request = json.loads(data)
                        label = request.get('displayName') if isinstance(request, dict) else None
                        if not isinstance(label, str) or not label.strip() or len(label.encode()) > 256:
                            self.reply(400)
                            return
                        # Creation by UUID is idempotent; name is display only.
                        connection.execute('INSERT OR IGNORE INTO vaults VALUES (?, ?)', (vault, label))
                        self.reply(200)
                        return
                    if not connection.execute('SELECT 1 FROM vaults WHERE id=?', (vault,)).fetchone():
                        self.reply(404)
                        return
                    if len(path) != 6 or path[4] != 'objects' or not OBJECT.fullmatch(unquote(path[5])):
                        self.reply(404)
                        return
                    object_id = unquote(path[5])
                    if self.command == 'GET':
                        row = connection.execute('SELECT data, revision FROM objects WHERE vault=? AND id=?', (vault, object_id)).fetchone()
                        self.reply(200, bytes(row[0]), row[1]) if row else self.reply(404)
                        return
                    if self.command != 'PUT':
                        self.reply(405)
                        return
                    revision = self.headers.get('If-Match')
                    absent = self.headers.get('If-None-Match') == '*'
                    if (revision is not None) == absent:
                        self.reply(400)
                        return
                    epoch = self.headers.get('X-Retention-Epoch')
                    if epoch is not None and (not epoch.isdigit() or int(epoch) > 2147483647):
                        self.reply(400)
                        return
                    # The transaction serializes competing clients. Failed
                    # conditions never modify bytes, revisions or metadata.
                    connection.execute('BEGIN IMMEDIATE')
                    row = connection.execute('SELECT revision FROM objects WHERE vault=? AND id=?', (vault, object_id)).fetchone()
                    if absent and row or not absent and (not row or row[0] != revision):
                        self.reply(412)
                        return
                    next_revision = '"' + secrets.token_hex(16) + '"'
                    connection.execute('INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?)',
                                       (vault, object_id, next_revision, data, int(epoch) if epoch is not None else None))
                    connection.commit()  # durable before acknowledging publication
                    self.reply(200, revision=next_revision)
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                self.reply(400)
            except sqlite3.Error:
                self.reply(503)

        do_GET = handle_request
        do_PUT = handle_request

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--port', type=int, default=18765)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if args.directory.is_symlink():
        parser.error('Use a disposable regular directory')
    args.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.directory.stat().st_mode & 0o077:
        parser.error('Provider directory must be private: chmod 700')
    database = args.directory / 'ciphertext.sqlite'
    token_path = args.directory / 'provider-token.txt'
    if args.resume:
        store = Store.reopen(database)
        if token_path.is_symlink() or token_path.stat().st_mode & 0o077:
            parser.error('Token must be a private regular file')
        token = token_path.read_text().strip()
    else:
        store = Store(database)
        token = secrets.token_urlsafe(32)
        descriptor = os.open(token_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(token)
    server = make_server(store, token, args.port)
    print(f'Test provider listening on http://127.0.0.1:{server.server_port}; token file: {token_path}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
