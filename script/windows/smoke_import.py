#!/usr/bin/env python3
"""Exercise compiled Breezer's import UI with synthetic files on a Windows desktop."""

import argparse
from configparser import ConfigParser
from contextlib import contextmanager, suppress
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[2]
WELCOME = "chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/workspace.html#/welcome"
BROWSER_IMPORT = "chrome://settings/importData"
PASSWORD_SETTINGS = "chrome://password-manager/settings"
BOOKMARK_URL = "https://breezer-import-smoke.example.test/"
BOOKMARK_TITLE = "Breezer import smoke bookmark"
FIREFOX_PROFILE = "Breezer import smoke"
FIREFOX_LOGIN_URL = "https://breezer-firefox-smoke.example.test/"
FIND_ELEMENT = """
    const find = (root, selector) => {
        const match = root.querySelector(selector);
        if (match) return match;
        for (const child of root.querySelectorAll('*')) {
            if (!child.shadowRoot) continue;
            const found = find(child.shadowRoot, selector);
            if (found) return found;
        }
    };
"""


def wait_for(description, condition, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(0.2)
    raise RuntimeError(f"Timed out waiting for {description}.")


@contextmanager
def browser(binary, driver, profile, firefox_fixture):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    opener = build_opener(ProxyHandler({}))

    def request(method, endpoint, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = Request(f"http://127.0.0.1:{port}{endpoint}", data=data, method=method,
                      headers={"Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=30) as response:
                return json.load(response)["value"]
        except HTTPError as error:
            message = json.load(error)["value"]["message"]
            raise RuntimeError(f"ChromeDriver {endpoint}: {message}") from error

    def ready():
        if process.poll() is not None:
            raise RuntimeError(f"ChromeDriver exited with status {process.returncode}.")
        try:
            return request("GET", "/status")["ready"]
        except URLError:
            return False

    with subprocess.Popen([driver, f"--port={port}"], stdout=subprocess.DEVNULL) as process:
        try:
            wait_for("ChromeDriver", ready, timeout=10)
            session = request("POST", "/session", {"capabilities": {"alwaysMatch": {
                "browserName": "chrome", "goog:chromeOptions": {
                    "binary": str(binary), "args": [
                        f"--user-data-dir={profile}", "--lang=en-US",
                        "--no-first-run", "--no-default-browser-check",
                    ],
                    # A migrated profile might have retained this old preference.
                    "prefs": {"import_dialog_saved_passwords": True} if firefox_fixture else {},
                },
            }}})
            base = "/session/" + session["sessionId"]
            try:
                capabilities = session["capabilities"]
                actual_profile = Path(capabilities["chrome"]["userDataDir"]).resolve()
                if actual_profile != profile.resolve():
                    raise RuntimeError("ChromeDriver did not open the disposable profile.")

                def command(method, endpoint, body=None):
                    return request(method, base + endpoint, body)

                yield command, capabilities["goog:processID"]
            finally:
                with suppress(URLError, RuntimeError):
                    request("DELETE", base)
        finally:
            if process.poll() is None:
                process.terminate()


def run(binary, driver, temporary, firefox_fixture):
    profile = temporary / "profile"
    csv = temporary / "passwords.csv"
    shutil.copyfile(ROOT / "tests/passwords/dummy.csv", csv)
    bookmark = temporary / "bookmarks.html"
    bookmark.write_text(
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n'
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n'
        f'<DL><p><DT><A HREF="{BOOKMARK_URL}">{BOOKMARK_TITLE}</A></DL><p>\n',
        encoding="utf-8",
    )
    with browser(binary, driver, profile, firefox_fixture) as (command, process_id):
        def script(source, *args, asynchronous=False):
            mode = "async" if asynchronous else "sync"
            return command("POST", "/execute/" + mode, {"script": source, "args": args})

        def switch(handle):
            command("POST", "/window", {"handle": handle})

        def switch_to(expected, *transient):
            def find():
                for handle in command("GET", "/window/handles"):
                    switch(handle)
                    if command("GET", "/url") in (expected, *transient):
                        return handle
                return False

            return wait_for(expected, find)

        def click(selector):
            wait_for(selector, lambda: script(FIND_ELEMENT + """
                const element = find(document, arguments[0]);
                if (!element?.checkVisibility() || element.disabled) return false;
                element.click();
                return true;
            """, selector))

        def choose_file(fixture):
            subprocess.run([
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "RemoteSigned",
                "-File", str(ROOT / "script/windows/select-import-fixture.ps1"),
                "-BrowserProcessId", str(process_id), "-Fixture", str(fixture),
            ], check=True, timeout=30)

        def assert_saved_login(username, url):
            wait_for("imported test entry in the native password manager", lambda: script("""
                const [username, url, done] = arguments;
                if (!chrome.passwordsPrivate) return done(false);
                chrome.passwordsPrivate.getSavedPasswordList(entries => done(entries.some(entry =>
                    entry.username === username && entry.urls.link.startsWith(url)
                )));
            """, username, url, asynchronous=True))

        command("POST", "/url", {"url": WELCOME})
        welcome = command("GET", "/window")
        for step in ("welcome", "layout", "theme"):
            wait_for(step, lambda: script(
                "return document.querySelector('section[data-step=' + arguments[0] + ']:not([hidden])')?.checkVisibility()",
                step,
            ))
            click("#wl-next")
        wait_for("Windows import instructions", lambda: script(
            "return document.querySelector('#wl-import-firefox')?.checkVisibility()"))
        click("#wl-import-browser")
        switch_to(BROWSER_IMPORT)
        wait_for("Bookmarks HTML File in the import dialog", lambda: script(FIND_ELEMENT + """
            const select = find(document, 'settings-import-data-dialog')?.shadowRoot?.querySelector('#browserSelect');
            if (!select?.options.length) return false;
            const file = [...select.options].find(option => /Bookmarks HTML File/i.test(option.text));
            if (!file) return false;
            select.value = file.value;
            select.dispatchEvent(new Event('change'));
            return true;
        """))
        click("cr-button#import")
        choose_file(bookmark)
        click("cr-button#done")
        command("POST", "/url", {"url": "chrome://bookmarks/"})
        wait_for("imported bookmark in the native bookmark manager", lambda: script("""
            const [url, title, done] = arguments;
            if (!chrome.bookmarks) return done(false);
            chrome.bookmarks.search({url}, items => done(items.some(item => item.title === title)));
        """, BOOKMARK_URL, BOOKMARK_TITLE, asynchronous=True))
        print("PASS: setup opened browser import and native bookmarks imported the synthetic HTML.", flush=True)

        switch(welcome)
        click("#wl-import-passwords")
        switch_to(PASSWORD_SETTINGS, PASSWORD_SETTINGS + "?import=true")
        choose_file(csv)
        click("cr-button#viewPasswordsButton")
        assert_saved_login("dummy@example.test", "http://localhost:8765/")
        print("PASS: setup opened password import and the native manager saved the synthetic CSV.", flush=True)

        def open_firefox_import():
            switch(welcome)
            click("#wl-import-browser")
            switch_to(BROWSER_IMPORT)
            wait_for("the isolated Firefox fixture", lambda: script(FIND_ELEMENT + """
                const select = find(document, 'settings-import-data-dialog')?.shadowRoot?.querySelector('#browserSelect');
                const firefox = [...(select?.options || [])].filter(option => /Firefox/i.test(option.text));
                if (firefox.length !== 1) return false;
                select.value = firefox[0].value;
                select.dispatchEvent(new Event('change'));
                return true;
            """))

        def assert_firefox_unchecked():
            wait_for("the unchecked Firefox password option", lambda: script(FIND_ELEMENT + """
                const root = find(document, 'settings-import-data-dialog')?.shadowRoot;
                const passwords = root?.querySelector('#importDialogSavedPasswords');
                if (!passwords || passwords.hidden || !passwords.pref) return false;
                if (passwords.checked) throw new Error('Saved passwords was selected by default');
                return true;
            """))

        if firefox_fixture:
            open_firefox_import()
            assert_firefox_unchecked()
            wait_for("the Firefox password option", lambda: script(FIND_ELEMENT + """
                const root = find(document, 'settings-import-data-dialog')?.shadowRoot;
                const passwords = root?.querySelector('#importDialogSavedPasswords');
                if (!passwords || passwords.hidden || !passwords.pref) return false;
                for (const control of root.querySelectorAll('settings-checkbox:not([hidden])')) {
                    if (control.checked) control.shadowRoot.querySelector('cr-checkbox').click();
                }
                passwords.shadowRoot.querySelector('cr-checkbox').click();
                if (!passwords.checked) throw new Error('Could not select Saved passwords');
                return true;
            """))
            click("cr-button#import")
            click("cr-button#done")
            command("POST", "/url", {"url": "chrome://password-manager/passwords"})
            assert_saved_login("dummy-firefox@example.test", FIREFOX_LOGIN_URL)
            open_firefox_import()
            assert_firefox_unchecked()
            print("PASS: Firefox direct import saved the synthetic entry and requested consent again.", flush=True)


def check_firefox_fixture_account():
    ini = Path(os.environ["APPDATA"]) / "Mozilla/Firefox/profiles.ini"
    config = ConfigParser(interpolation=None)
    config.read(ini, encoding="utf-8-sig")
    profiles = [config[section].get("Name") for section in config if section.startswith("Profile")]
    if profiles != [FIREFOX_PROFILE]:
        raise RuntimeError(f"Use a disposable Windows account with one Firefox profile named {FIREFOX_PROFILE!r}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", required=True, type=Path)
    parser.add_argument("--driver", required=True, type=Path)
    parser.add_argument("--firefox-fixture", action="store_true",
                        help="Also exercise direct import from the prepared disposable Firefox profile.")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Run this check on an unlocked Windows desktop.")
    try:
        if args.firefox_fixture:
            check_firefox_fixture_account()
        with tempfile.TemporaryDirectory(prefix="breezer-import-smoke-") as directory:
            run(args.browser.resolve(strict=True), args.driver.resolve(strict=True),
                Path(directory), args.firefox_fixture)
    except (KeyError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Import smoke failed: {error}\n")


if __name__ == "__main__":
    main()
