#!/usr/bin/env python3
"""Exercise an exact Linux ARM64 release artifact against disposable local data.

Requires Docker and the official postgres:16-bookworm image (including its CA
trust store for API client initialization). Uses a dedicated network, a tmpfs database, and a loopback-only
API port. Never connects to production or reads real credentials. Cookies and
local OTPs remain in memory. Both containers and their network are removed.
"""
import argparse
import hashlib
import http.cookiejar
import json
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

PERSONAL = "11111111-1111-4111-8111-111111111111"
WORK = "22222222-2222-4222-8222-222222222222"
EMAIL = "artifact-check@example.test"


def run(*args, input=None, check=True):
    result = subprocess.run(args, input=input, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr[-2000:]}")
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Browser:
    def __init__(self, origin):
        self.origin = origin
        self.http = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def request(self, path, body=None, expected=200):
        request = urllib.request.Request(
            self.origin + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Origin": self.origin, "Content-Type": "application/json"},
        )
        try:
            response = self.http.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            payload = json.loads(response.read())
            if response.status != expected:
                code = payload.get("error", {}).get("code", "unknown")
                raise AssertionError(f"{path}: HTTP {response.status}, {code}")
            return payload

    def flow(self, **extra):
        return self.request("/v1/flows", {
            "app_id": "silicon-accounts",
            "redirect_uri": self.origin + "/sign-in",
            "state": secrets.token_urlsafe(20),
            **extra,
        }, expected=201)["flow"]

    def select(self, flow, account):
        result = self.request(f"/v1/flows/{flow['id']}/select-account", {
            "account_uuid": account,
        })["flow"]
        assert result["step"] == "complete", result["step"]
        assert result["signed_in_as"]["uuid"] == account


def choices(flow):
    assert flow["step"] == "select_account", f"expected direct chooser, got {flow['step']}"
    assert {a["uuid"] for a in flow["accounts"]} == {PERSONAL, WORK}
    personal = next(a for a in flow["accounts"] if a["uuid"] == PERSONAL)
    work = next(a for a in flow["accounts"] if a["uuid"] == WORK)
    assert personal["org"] is None
    assert work["org"]["name"] == "Artifact Test Organization"
    assert work["allowed"] is True
    assert flow["redirect_to"] is None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--migrate", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    assert digest(args.binary) == args.sha256, "release binary digest mismatch"
    name = "accounts-chooser-" + secrets.token_hex(5)
    db, api = name + "-db", name + "-api"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://localhost:{port}"
    checks = []

    def passed(label):
        checks.append(label)
        print("PASS " + label, flush=True)

    def sql(statement):
        return run("docker", "exec", "-i", db, "psql", "-U", "postgres",
                   "-v", "ON_ERROR_STOP=1", "-qAt", input=statement).stdout

    with tempfile.TemporaryDirectory(prefix="accounts-chooser-artifact-") as temp:
        bundle = Path(temp)
        shutil.copy2(args.binary, bundle / "accounts-api")
        shutil.copy2(args.migrate, bundle / "accounts-migrate")
        assert digest(bundle / "accounts-api") == args.sha256, "binary changed while copying"
        env = ["-e", "ACCOUNTS_DATABASE_URL=postgres://postgres@fixture-db:5432/postgres"]
        mount = ["-v", f"{bundle}:/bundle:ro"]
        try:
            run("docker", "network", "create", name)
            run("docker", "run", "-d", "--name", db, "--network", name,
                "--network-alias", "fixture-db", "--tmpfs", "/var/lib/postgresql/data",
                "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16-bookworm")
            for _ in range(60):
                if run("docker", "exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", check=False).returncode == 0:
                    break
                time.sleep(0.5)
            run("docker", "run", "--rm", "--network", name, *mount, *env,
                "postgres:16-bookworm", "/bundle/accounts-migrate")
            sql(f"""
                insert into organization_projections(org_id,name)
                values('artifactorg','Artifact Test Organization');
                insert into accounts(uuid,number,kind,handle,status,display_name,pfp_url,dob,timezone,org_id)
                values
                ('{PERSONAL}',nextval('account_number_seq'),'carbon','c:artifactpersonal','active',
                 'Artifact Personal','{origin}/photo','1990-01-01','UTC',null),
                ('{WORK}',nextval('account_number_seq'),'carbon','c:artifactwork.artifactorg','active',
                 'Artifact Work','{origin}/photo','1990-01-01','UTC','artifactorg');
                insert into account_emails(email,account_uuid,is_primary,verified_at,verified_via)
                values('{EMAIL}','{PERSONAL}',true,now(),'code');
                insert into account_links(account_uuid,main_uuid)
                values('{PERSONAL}','{PERSONAL}'),('{WORK}','{PERSONAL}');
                insert into organization_account_policies(account_uuid,version,mode)
                values('{WORK}',1,'everywhere');
            """)
            run("docker", "run", "-d", "--name", api, "--network", name,
                "--read-only", "--tmpfs", "/tmp", *mount, *env,
                "-p", f"127.0.0.1:{port}:8589",
                "-e", "ACCOUNTS_ENVIRONMENT=development",
                "-e", "ACCOUNTS_BIND_ADDR=0.0.0.0:8589",
                "-e", f"ACCOUNTS_PUBLIC_URL={origin}",
                "-e", "ACCOUNTS_IRIS_BASE_URL=http://localhost:8589",
                "-e", "ACCOUNTS_SILICON_APPS_URL=http://localhost:8589",
                "-e", "ACCOUNTS_DELIVERY=local",
                "-e", "ACCOUNTS_EXPOSE_DEV_OUTBOX=true",
                "-e", "ACCOUNTS_WORKER_ENABLED=false",
                "postgres:16-bookworm", "/bundle/accounts-api")
            browser = Browser(origin)
            for attempt in range(60):
                try:
                    assert browser.request("/readyz")["database"] == "ok"
                    break
                except (OSError, AssertionError):
                    if attempt == 59:
                        raise RuntimeError("release artifact failed local readiness") from None
                    time.sleep(0.5)
            passed("exact Linux release artifact starts against fresh migrations")
            flow = browser.flow(prompt="login")
            assert flow["step"] == "choose_method" and not flow["accounts"]
            browser.request(f"/v1/flows/{flow['id']}/email", {"email": EMAIL})
            code = browser.request("/v1/dev/outbox?to=" + EMAIL)["items"][0]["code"]
            flow = browser.request(f"/v1/flows/{flow['id']}/verify", {"code": code})["flow"]
            choices(flow)
            passed("one verified email offers separate Personal and Work identities")
            browser.select(flow, WORK)
            passed("work identity can be selected after one email sign-in")
            flow = browser.flow()
            choices(flow)
            passed("remembered work session immediately offers both identities")
            browser.select(flow, PERSONAL)
            passed("personal identity can be selected without another authentication")
            choices(browser.flow())
            passed("remembered personal session immediately offers both identities")
            flow = browser.flow(prompt="login")
            assert flow["step"] == "choose_method" and not flow["accounts"]
            anonymous = Browser(origin).flow()
            assert anonymous["step"] == "choose_method" and not anonymous["accounts"]
            passed("fresh-auth and anonymous flows do not expose linked choices")
            report = {
                "api_sha256": args.sha256,
                "migrate_sha256": digest(bundle / "accounts-migrate"),
                "local_only": True,
                "production_records_created": False,
                "checks_passed": checks,
            }
        finally:
            run("docker", "rm", "-f", "-v", api, db, check=False)
            run("docker", "network", "rm", name, check=False)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print("Evidence: " + str(args.output), flush=True)


if __name__ == "__main__":
    main()
