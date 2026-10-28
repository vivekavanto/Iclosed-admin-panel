"""Read-only Closer readiness probe. Never creates a matter or exports a session."""
import argparse
import json
from pathlib import Path

def probe(profile, expected_account):
    from playwright.sync_api import sync_playwright
    profile = Path(profile).resolve()
    if not profile.is_dir():
        return {"status": "profile_missing", "creation_enabled": False}
    if (profile / "SingletonLock").exists() or (profile / "SingletonLock").is_symlink():
        return {"status": "profile_busy", "creation_enabled": False}
    with sync_playwright() as runtime:
        context = runtime.chromium.launch_persistent_context(str(profile), headless=True, accept_downloads=False)
        try:
            page = context.new_page()
            page.goto("https://app.closer.ca/app/view-all-files", wait_until="domcontentloaded")
            if "/login" in page.url:
                return {"status": "login_required", "creation_enabled": False}
            page.get_by_role("link", name="Settings", exact=True).click(timeout=20000)
            email = page.locator('input[name="email"]')
            email.wait_for(timeout=15000)
            if email.input_value().strip().lower() != expected_account.lower():
                return {"status": "account_mismatch", "creation_enabled": False}
            return {"status": "authenticated", "account_verified": True, "creation_enabled": False,
                    "execution": "deterministic_playwright", "model_calls": 0}
        finally:
            context.close()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--expected-account", required=True)
    args = parser.parse_args()
    try:
        result = probe(args.profile, args.expected_account)
    except Exception as error:
        # Do not expose browser traces, credentials, page content or client records.
        result = {"status": "probe_failed", "error_type": type(error).__name__, "creation_enabled": False}
    print(json.dumps(result))
    return 0 if result["status"] == "authenticated" else 2

if __name__ == "__main__":
    raise SystemExit(main())
